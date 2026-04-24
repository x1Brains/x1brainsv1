// programs/brains_farm/src/lib.rs
// X1 Brains Farm — LP Staking Protocol
// Built with Anchor 0.32.1 on X1 Mainnet (SVM-compatible)

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;
pub mod accumulator;
pub mod instructions;

use instructions::*;
use state::*;

// Security contact — embedded in program binary
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "X1 Brains Farm",
    project_url: "https://x1brains.io",
    contacts: "link:https://x1brains.io/security,twitter:@x1brains",
    policy: "Responsible disclosure appreciated. Contact before public disclosure.",
    preferred_languages: "en",
    source_code: "https://github.com/x1Brains/x1brainsv1"
}

// TODO: generate keypair and paste pubkey:
//   solana-keygen new -o target/deploy/brains_farm-keypair.json
//   solana-keygen pubkey target/deploy/brains_farm-keypair.json
declare_id!("Ci1qDtdoSh8mCtJTVoX1tArbnLydQUZYu9RiqukRFJpg");

#[program]
pub mod brains_farm {
    use super::*;

    // ── Admin: one-time setup ─────────────────────────────────────────────────
    pub fn initialize_global(ctx: Context<InitializeGlobal>) -> Result<()> {
        initialize_global::handler(ctx)
    }

    // ── Admin: farm lifecycle ─────────────────────────────────────────────────
    pub fn create_farm(
        ctx: Context<CreateFarm>,
        params: CreateFarmParams,
    ) -> Result<()> {
        create_farm::handler(ctx, params)
    }

    pub fn close_farm(ctx: Context<CloseFarm>) -> Result<()> {
        close_farm::handler(ctx)
    }

    // ── Admin: runtime controls ───────────────────────────────────────────────
    pub fn pause(ctx: Context<GlobalAdmin>) -> Result<()> {
        admin::pause_handler(ctx)
    }

    pub fn unpause(ctx: Context<GlobalAdmin>) -> Result<()> {
        admin::unpause_handler(ctx)
    }

    pub fn pause_farm(ctx: Context<FarmAdmin>) -> Result<()> {
        admin::pause_farm_handler(ctx)
    }

    pub fn unpause_farm(ctx: Context<FarmAdmin>) -> Result<()> {
        admin::unpause_farm_handler(ctx)
    }

    pub fn update_rate(
        ctx: Context<UpdateRate>,
        params: UpdateRateParams,
    ) -> Result<()> {
        admin::update_rate_handler(ctx, params)
    }

    pub fn withdraw_rewards(
        ctx: Context<WithdrawRewards>,
        params: WithdrawRewardsParams,
    ) -> Result<()> {
        admin::withdraw_rewards_handler(ctx, params)
    }

    // ── Permissionless: fund the reward vault ─────────────────────────────────
    // Used for: admin initial seed, community donations, treasury sweeps.
    pub fn fund_farm(
        ctx: Context<FundFarm>,
        params: FundFarmParams,
    ) -> Result<()> {
        fund_farm::handler(ctx, params)
    }

    // ── User: stake / claim / unstake ─────────────────────────────────────────
    pub fn stake(
        ctx: Context<Stake>,
        params: StakeParams,
    ) -> Result<()> {
        stake::handler(ctx, params)
    }

    pub fn claim(
        ctx: Context<Claim>,
        params: ClaimParams,
    ) -> Result<()> {
        claim::handler(ctx, params)
    }

    pub fn unstake(
        ctx: Context<Unstake>,
        params: UnstakeParams,
    ) -> Result<()> {
        unstake::handler(ctx, params)
    }

    // ── Admin test tools (feature-gated) ──────────────────────────────────────
    // ONLY exists in binaries built with `--features admin-test-tools`.
    // Mainnet binaries built without this feature do NOT contain this ix.
    #[cfg(feature = "admin-test-tools")]
    pub fn force_mature_position(
        ctx: Context<ForceMaturePosition>,
        nonce: u32,
        target_owner: Pubkey,
    ) -> Result<()> {
        force_mature_position::handler(ctx, nonce, target_owner)
    }
}
