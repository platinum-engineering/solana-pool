use std::ops::DerefMut;

use anchor_lang::{prelude::*, solana_program::log::sol_log_64, AccountsClose};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use az::CheckedAs;

declare_id!("BHfLU4UsBdxBZk56GjpGAXkzu8B7JdMitGa9A1VTMmva");

#[account]
#[derive(Debug)]
pub struct Pool {
    admin: Pubkey,
    bump: u8,

    genesis: i64,
    topup_duration: i64,
    lockup_duration: i64,

    stake_acquired_amount: u64,
    stake_target_amount: u64,
    reward_amount: u64,
    deposited_reward_amount: u64,

    stake_mint: Pubkey,
    stake_vault: Pubkey,
}

impl Pool {
    pub const LEN: usize = 8 + std::mem::size_of::<Self>();

    fn can_topup(&self, now: i64) -> bool {
        now < self.genesis + self.topup_duration
    }

    fn is_expired(&self, now: i64) -> bool {
        now > self.genesis + self.lockup_duration
    }
}

#[account]
pub struct Ticket {
    authority: Pubkey,
    pool: Pubkey,
    staked_amount: u64,
    bump: u8,
}

impl Default for Ticket {
    fn default() -> Self {
        Self {
            authority: Default::default(),
            pool: Default::default(),
            staked_amount: Default::default(),
            bump: Default::default(),
        }
    }
}

#[error]
pub enum ErrorCode {
    #[msg("Given bump is invalid")]
    InvalidBump,
    #[msg("Given authority does not match expected one")]
    InvalidAuthority,
    #[msg("Given topup duration lasts longer than lockup duration")]
    TopupLongerThanLockup,
    #[msg("Given wallet has not enough funds")]
    NotEnoughFunds,
    #[msg("Pool is locked and funds can no longer be added")]
    PoolIsLocked,
    #[msg("Pool is full")]
    PoolIsFull,
    #[msg("Pool rewards are full")]
    PoolRewardsAreFull,
    #[msg("Pool is not expired yet")]
    PoolIsNotExpired,
    #[msg("Pool is expired already")]
    PoolIsExpired,
    #[msg("Not enough rewards to collect")]
    NotEnoughRewards,
    #[msg("Invalid amount transferred")]
    InvalidAmountTransferred,
    #[msg("Integer overflow occured")]
    IntegerOverlow,
}

#[program]
pub mod solana_pool {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, args: InitializePoolArgs) -> Result<()> {
        let now = ctx.accounts.clock.unix_timestamp;

        require!(
            args.topup_duration <= args.lockup_duration,
            TopupLongerThanLockup
        );

        let pool = ctx.accounts.pool.deref_mut();

        *pool = Pool {
            admin: ctx.accounts.admin.key(),
            bump: args.bump,
            genesis: now,
            topup_duration: args.topup_duration,
            lockup_duration: args.lockup_duration,
            stake_target_amount: args.target_amount,
            stake_acquired_amount: 0,
            reward_amount: args.reward_amount,
            deposited_reward_amount: 0,
            stake_mint: ctx.accounts.stake_mint.key(),
            stake_vault: ctx.accounts.stake_vault.key(),
        };

        Ok(())
    }

    pub fn add_stake(ctx: Context<AddStake>, amount: u64, bump: u8) -> Result<()> {
        require!(ctx.accounts.source_wallet.amount >= amount, NotEnoughFunds);

        let now = ctx.accounts.clock.unix_timestamp;

        let pool = &mut ctx.accounts.pool;
        let ticket = &mut ctx.accounts.ticket;
        let stake_vault = &mut ctx.accounts.stake_vault;

        require!(pool.can_topup(now), PoolIsLocked);

        let transfer_amount = std::cmp::min(
            amount,
            pool.stake_target_amount - pool.stake_acquired_amount,
        );

        require!(transfer_amount > 0, PoolIsFull);

        TokenTransfer {
            amount: transfer_amount,
            from: &mut ctx.accounts.source_wallet,
            to: &stake_vault,
            authority: &ctx.accounts.source_authority,
            token_program: &ctx.accounts.token_program,
            signers: None,
        }
        .make()?;

        pool.stake_acquired_amount += transfer_amount;

        ticket.authority = ctx.accounts.staker.key();
        ticket.pool = pool.key();
        ticket.staked_amount = transfer_amount;
        ticket.bump = bump;

        Ok(())
    }

    pub fn remove_stake(ctx: Context<RemoveStake>, amount: u64) -> Result<()> {
        let now = ctx.accounts.clock.unix_timestamp;

        let pool = &mut ctx.accounts.pool;
        let ticket = &mut ctx.accounts.ticket;
        let stake_vault = &mut ctx.accounts.stake_vault;

        require!(pool.can_topup(now), PoolIsLocked);

        let transfer_amount = std::cmp::min(amount, ticket.staked_amount);

        let pool_key = pool.key();
        let seeds = &[pool_key.as_ref(), pool.admin.as_ref(), &[pool.bump]];
        let signer = &[&seeds[..]];

        TokenTransfer {
            amount: transfer_amount,
            from: stake_vault,
            to: &ctx.accounts.target_wallet,
            authority: &ctx.accounts.pool_authority,
            token_program: &ctx.accounts.token_program,
            signers: Some(signer),
        }
        .make()?;

        pool.stake_acquired_amount -= transfer_amount;

        ticket.staked_amount -= transfer_amount;

        if ticket.staked_amount == 0 {
            ticket.close(ctx.accounts.staker.to_account_info())?
        }

        Ok(())
    }

    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        let now = ctx.accounts.clock.unix_timestamp;

        let pool = &mut ctx.accounts.pool;
        let ticket = &mut ctx.accounts.ticket;
        let stake_vault = &mut ctx.accounts.stake_vault;

        require!(pool.is_expired(now), PoolIsNotExpired);

        use fixed::types::U64F64;

        let staked_amount = U64F64::from_num(ticket.staked_amount);
        let stake_acquired_amount = U64F64::from_num(pool.stake_acquired_amount);
        let reward_amount = U64F64::from_num(pool.reward_amount);

        let share = staked_amount / stake_acquired_amount;
        let reward_share = share * reward_amount;

        let transfer_amount = (staked_amount + reward_share)
            .checked_as::<u64>()
            .ok_or(ErrorCode::IntegerOverlow)?;

        let pool_key = pool.key();
        let seeds = &[pool_key.as_ref(), pool.admin.as_ref(), &[pool.bump]];
        let signer = &[&seeds[..]];

        TokenTransfer {
            amount: transfer_amount,
            from: stake_vault,
            to: &ctx.accounts.target_wallet,
            authority: &ctx.accounts.pool_authority,
            token_program: &ctx.accounts.token_program,
            signers: Some(signer),
        }
        .make()?;

        ticket.close(ctx.accounts.staker.to_account_info())?;

        Ok(())
    }

    pub fn add_reward(ctx: Context<AddReward>, amount: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        let stake_vault = &mut ctx.accounts.stake_vault;

        let transfer_amount = amount
            .min(pool.reward_amount - pool.deposited_reward_amount)
            .min(ctx.accounts.source_wallet.amount);

        require!(transfer_amount > 0, NotEnoughRewards);

        let now = ctx.accounts.clock.unix_timestamp;

        require!(!pool.is_expired(now), PoolIsExpired);

        TokenTransfer {
            amount: transfer_amount,
            from: &mut ctx.accounts.source_wallet,
            to: stake_vault,
            authority: &ctx.accounts.source_authority,
            token_program: &ctx.accounts.token_program,
            signers: None,
        }
        .make()?;

        pool.deposited_reward_amount += transfer_amount;
        require!(
            pool.deposited_reward_amount <= pool.reward_amount,
            PoolRewardsAreFull
        );

        Ok(())
    }
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct InitializePoolArgs {
    bump: u8,
    topup_duration: i64,
    lockup_duration: i64,
    target_amount: u64,
    reward_amount: u64,
}

#[derive(Accounts)]
#[instruction(args: InitializePoolArgs)]
pub struct InitializePool<'info> {
    #[account(signer)]
    admin: AccountInfo<'info>,
    #[account(
        init,
        payer = admin,
        space = Pool::LEN
    )]
    pool: ProgramAccount<'info, Pool>,
    #[account(
        seeds = [
            pool.key().as_ref(),
            admin.key().as_ref(),
        ],
        bump = args.bump
    )]
    pool_authority: AccountInfo<'info>,

    #[account(
        constraint = stake_mint.key() == stake_vault.mint
    )]
    stake_mint: Account<'info, Mint>,
    #[account(
        constraint = stake_vault.owner == pool_authority.key()
    )]
    stake_vault: Account<'info, TokenAccount>,

    pub clock: Sysvar<'info, Clock>,
    system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, bump: u8)]
pub struct AddStake<'info> {
    #[account(mut)]
    pool: ProgramAccount<'info, Pool>,
    #[account(signer)]
    staker: AccountInfo<'info>,
    #[account(
        init,
        payer = staker,
        seeds = [
            pool.key().as_ref(),
            staker.key().as_ref(),
        ],
        bump = bump,
    )]
    ticket: ProgramAccount<'info, Ticket>,
    #[account(mut)]
    stake_vault: Account<'info, TokenAccount>,
    #[account(signer)]
    source_authority: AccountInfo<'info>,
    #[account(mut)]
    source_wallet: Account<'info, TokenAccount>,

    clock: Sysvar<'info, Clock>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveStake<'info> {
    #[account(mut)]
    pool: ProgramAccount<'info, Pool>,
    #[account(mut, signer)]
    staker: AccountInfo<'info>,
    #[account(
        mut,
        constraint = ticket.authority == staker.key(),
        seeds = [
            pool.key().as_ref(),
            staker.key().as_ref()
        ],
        bump = ticket.bump,
    )]
    ticket: ProgramAccount<'info, Ticket>,
    #[account(
        seeds = [
            pool.key().as_ref(),
            pool.admin.as_ref(),
        ],
        bump = pool.bump
    )]
    pool_authority: AccountInfo<'info>,
    #[account(mut)]
    stake_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    target_wallet: Account<'info, TokenAccount>,

    clock: Sysvar<'info, Clock>,
    token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    pool: ProgramAccount<'info, Pool>,
    #[account(mut, signer)]
    staker: AccountInfo<'info>,
    #[account(
        mut,
        constraint = ticket.authority == staker.key(),
        seeds = [
            pool.key().as_ref(),
            staker.key().as_ref()
        ],
        bump = ticket.bump,
    )]
    ticket: ProgramAccount<'info, Ticket>,
    #[account(
        seeds = [
            pool.key().as_ref(),
            pool.admin.as_ref(),
        ],
        bump = pool.bump
    )]
    pool_authority: AccountInfo<'info>,
    #[account(mut)]
    stake_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    target_wallet: Account<'info, TokenAccount>,

    pub clock: Sysvar<'info, Clock>,
    token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AddReward<'info> {
    #[account(mut)]
    pool: ProgramAccount<'info, Pool>,
    #[account(mut)]
    stake_vault: Account<'info, TokenAccount>,
    #[account(signer)]
    source_authority: AccountInfo<'info>,
    #[account(mut)]
    source_wallet: Account<'info, TokenAccount>,

    pub clock: Sysvar<'info, Clock>,
    token_program: Program<'info, Token>,
}

struct TokenTransfer<'pay, 'info> {
    amount: u64,
    from: &'pay mut Account<'info, TokenAccount>,
    to: &'pay Account<'info, TokenAccount>,
    authority: &'pay AccountInfo<'info>,
    token_program: &'pay Program<'info, Token>,
    signers: Option<&'pay [&'pay [&'pay [u8]]]>,
}

impl TokenTransfer<'_, '_> {
    fn make(self) -> Result<()> {
        let amount_before = self.from.amount;

        self.from.key().log();
        self.to.key().log();
        self.authority.key().log();

        let cpi_ctx = CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.from.to_account_info(),
                to: self.to.to_account_info(),
                authority: self.authority.to_account_info(),
            },
        );
        let cpi_ctx = match self.signers {
            Some(signers) => cpi_ctx.with_signer(signers),
            None => cpi_ctx,
        };

        token::transfer(cpi_ctx, self.amount)?;

        self.from.reload()?;
        let amount_after = self.from.amount;

        sol_log_64(amount_before, amount_after, self.amount, 0, 0);

        require!(
            amount_before - amount_after == self.amount,
            InvalidAmountTransferred
        );

        Ok(())
    }
}
