// programs/brains_farm/src/accumulator.rs
// Shared reward accumulator logic — the MasterChef-style math heart of the farm.
//
// Every instruction that touches stakes (stake, claim, unstake, update_rate)
// MUST call settle_farm() first to bring acc_reward_per_share up to date,
// then compute the user's earned rewards against the updated accumulator.
//
// Key invariant: emissions are capped at every settle. If the vault doesn't
// have enough tokens to cover the full time_elapsed × rate emission, we only
// emit what's available. This makes the "runs until vault empty" model safe.

use anchor_lang::prelude::*;
use crate::{constants::*, errors::FarmError, state::*};

/// Settle the farm's accumulator — advance `acc_reward_per_share` to `now`
/// based on elapsed time, emission rate, and available vault balance.
///
/// Returns the amount emitted during this settle (for stat tracking).
///
/// Must be called before ANY operation that reads a position's pending_rewards
/// or mutates total_effective.
pub fn settle_farm(
    farm: &mut Farm,
    reward_vault_balance: u64,
    now: i64,
) -> Result<u64> {
    // Sanity: clock drift — if time went backwards, clamp and emit nothing
    if now <= farm.last_update_ts {
        return Ok(0);
    }

    let time_elapsed = now
        .checked_sub(farm.last_update_ts)
        .ok_or(FarmError::Overflow)? as u128;

    // If no one is staked, nothing accrues — just advance the timestamp
    if farm.total_effective == 0 {
        farm.last_update_ts = now;
        return Ok(0);
    }

    // Potential emission = time × rate. Rate is already scaled by ACC_PRECISION,
    // so potential_emission_scaled is in "scaled reward units".
    let potential_scaled = time_elapsed
        .checked_mul(farm.reward_rate_per_sec)
        .ok_or(FarmError::Overflow)?;

    // Convert back to raw reward units to cap against vault balance
    let potential_raw = potential_scaled
        .checked_div(ACC_PRECISION)
        .ok_or(FarmError::Overflow)?;

    // Cap at available (un-earmarked) vault balance
    let available_raw = reward_vault_balance
        .saturating_sub(farm.total_pending_rewards);

    let actual_raw = if (potential_raw as u64) > available_raw {
        available_raw
    } else {
        potential_raw as u64
    };

    // If we couldn't emit the full potential, scale the accumulator growth down
    // proportionally so the math stays consistent.
    let actual_scaled = (actual_raw as u128)
        .checked_mul(ACC_PRECISION)
        .ok_or(FarmError::Overflow)?;

    // acc_reward_per_share += actual_scaled / total_effective
    let per_share_delta = actual_scaled
        .checked_div(farm.total_effective as u128)
        .ok_or(FarmError::Overflow)?;

    farm.acc_reward_per_share = farm.acc_reward_per_share
        .checked_add(per_share_delta)
        .ok_or(FarmError::Overflow)?;

    farm.total_pending_rewards = farm.total_pending_rewards
        .checked_add(actual_raw)
        .ok_or(FarmError::Overflow)?;

    farm.total_emitted = farm.total_emitted
        .checked_add(actual_raw)
        .ok_or(FarmError::Overflow)?;

    farm.last_update_ts = now;

    Ok(actual_raw)
}

/// Calculate pending rewards for a position based on the farm's current
/// accumulator. Does NOT mutate — use credit_position() for that.
pub fn calc_pending(
    position: &StakePosition,
    farm: &Farm,
) -> Result<u64> {
    if position.effective_amount == 0 {
        return Ok(0);
    }
    // earned = effective_amount × (acc - reward_debt) / ACC_PRECISION
    let delta = farm.acc_reward_per_share
        .checked_sub(position.reward_debt)
        .ok_or(FarmError::Overflow)?;

    let raw = (position.effective_amount as u128)
        .checked_mul(delta)
        .ok_or(FarmError::Overflow)?
        .checked_div(ACC_PRECISION)
        .ok_or(FarmError::Overflow)? as u64;

    Ok(raw)
}

/// Settle a position's pending_rewards against the farm's current accumulator,
/// then snapshot reward_debt. Call after settle_farm().
pub fn credit_position(
    position: &mut StakePosition,
    farm: &Farm,
) -> Result<()> {
    let earned = calc_pending(position, farm)?;
    position.pending_rewards = position.pending_rewards
        .checked_add(earned)
        .ok_or(FarmError::Overflow)?;
    position.reward_debt = farm.acc_reward_per_share;
    Ok(())
}

/// Compute the early-exit penalty for a position based on how far it is
/// through its lock period and whether the user holds the LB discount.
///
/// Returns (penalty_bps, penalty_raw_lp).
///
/// Rules:
///   - During grace (first 3 days from start_ts): 0%
///   - Period 1 (past grace, first 50% of lock duration):
///       4.000% standard, 1.888% LB holders
///   - Period 2 (50% → 100% of lock duration):
///       1.888% standard, 0.888% LB holders
///   - After maturity (past unlock_ts): 0%
pub fn calc_early_exit_penalty(
    position: &StakePosition,
    lb_balance: u64,
    now: i64,
) -> Result<(u64, u64)> {
    // Within grace? No penalty.
    if now <= position.grace_end_ts {
        return Ok((0, 0));
    }

    // Past unlock_ts (matured)? No penalty.
    if now >= position.unlock_ts {
        return Ok((0, 0));
    }

    // Compute midpoint of the lock (start_ts + lock_duration/2)
    let midpoint_ts = position.start_ts
        .checked_add(position.lock_duration / 2)
        .ok_or(FarmError::Overflow)?;

    let has_lb_discount = lb_balance >= LB_DISCOUNT_THRESHOLD;

    let penalty_bps = if now < midpoint_ts {
        // Period 1 — past grace, before midpoint
        if has_lb_discount {
            PENALTY_P1_DISCOUNT_BPS
        } else {
            PENALTY_P1_STANDARD_BPS
        }
    } else {
        // Period 2 — past midpoint, before unlock
        if has_lb_discount {
            PENALTY_P2_DISCOUNT_BPS
        } else {
            PENALTY_P2_STANDARD_BPS
        }
    };

    let penalty_raw = (position.amount as u128)
        .checked_mul(penalty_bps as u128)
        .ok_or(FarmError::Overflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(FarmError::Overflow)? as u64;

    Ok((penalty_bps, penalty_raw))
}

/// Read an SPL token account's balance from its raw bytes.
/// Used for the LB-balance discount check without needing to deserialize
/// the full account layout.
/// Token account `amount` field is at offset 64 in both SPL and Token-2022.
pub fn read_token_account_balance(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Err(error!(FarmError::InvalidAccountData));
    }
    let bytes: [u8; 8] = data[64..72]
        .try_into()
        .map_err(|_| FarmError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}
