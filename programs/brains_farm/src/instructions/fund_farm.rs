// programs/brains_farm/src/instructions/fund_farm.rs
// Permissionless — anyone can deposit reward tokens into the vault.
// Used for: (1) admin initial seed after create_farm, (2) community donations,
// (3) periodic treasury sweeps.
//
// Effect: vault balance grows. Rate unchanged. Runway extends naturally since
// emissions-until-empty now takes longer to hit. APR displayed to users is
// unchanged. Admin can separately call update_rate to convert runway into APR.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    Mint, TokenAccount, TokenInterface,
    TransferChecked, transfer_checked,
};
use anchor_spl::token_2022_extensions::transfer_fee::{
    transfer_checked_with_fee, TransferCheckedWithFee,
};
use crate::{errors::FarmError, state::*};

#[derive(Accounts)]
pub struct FundFarm<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        seeds  = [b"farm", farm.lp_mint.as_ref(), farm.reward_mint.as_ref()],
        bump   = farm.bump,
        constraint = !farm.closed @ FarmError::FarmClosed,
    )]
    pub farm: Account<'info, Farm>,

    #[account(
        address = farm.reward_mint @ FarmError::RewardMintMismatch,
    )]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint          = reward_mint,
        associated_token::authority     = funder,
        associated_token::token_program = token_program,
    )]
    pub funder_reward_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        address = farm.reward_vault @ FarmError::InvalidAccountData,
        token::mint          = reward_mint,
        token::authority     = farm,
        token::token_program = token_program,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<FundFarm>, params: FundFarmParams) -> Result<()> {
    require!(params.amount > 0, FarmError::ZeroAmount);

    // Handle Token-2022 transfer fees if reward mint has TransferFeeConfig.
    // Pattern mirrors brains_pairing/create_listing.rs.
    let is_token_2022 = ctx.accounts.token_program.key()
        == anchor_spl::token_2022::spl_token_2022::id();

    if is_token_2022 {
        let transfer_fee = {
            use anchor_spl::token_2022::spl_token_2022::{
                extension::{BaseStateWithExtensions, StateWithExtensions, transfer_fee::TransferFeeConfig},
                state::Mint as SplMint,
            };
            let mint_info = ctx.accounts.reward_mint.to_account_info();
            let mint_data = mint_info.try_borrow_data()?;
            let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)
                .map_err(|_| FarmError::InvalidAccountData)?;
            if let Ok(fee_config) = mint_state.get_extension::<TransferFeeConfig>() {
                let epoch = Clock::get()?.epoch;
                fee_config.get_epoch_fee(epoch).calculate_fee(params.amount).unwrap_or(0)
            } else {
                0u64
            }
        };

        transfer_checked_with_fee(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferCheckedWithFee {
                    token_program_id: ctx.accounts.token_program.to_account_info(),
                    source:           ctx.accounts.funder_reward_ata.to_account_info(),
                    mint:             ctx.accounts.reward_mint.to_account_info(),
                    destination:      ctx.accounts.reward_vault.to_account_info(),
                    authority:        ctx.accounts.funder.to_account_info(),
                },
            ),
            params.amount,
            ctx.accounts.reward_mint.decimals,
            transfer_fee,
        )?;
    } else {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from:      ctx.accounts.funder_reward_ata.to_account_info(),
                    mint:      ctx.accounts.reward_mint.to_account_info(),
                    to:        ctx.accounts.reward_vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            params.amount,
            ctx.accounts.reward_mint.decimals,
        )?;
    }

    // Reload vault to confirm actual balance (after any Token-2022 fee)
    ctx.accounts.reward_vault.reload()?;

    msg!("Farm funded: {} tokens from {} (vault balance now {})",
        params.amount, ctx.accounts.funder.key(), ctx.accounts.reward_vault.amount);

    Ok(())
}
