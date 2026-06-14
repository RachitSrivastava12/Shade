use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

declare_id!("EhAEENuUTGpx6a35Xaex6Y6KPnpbxoa7zZsE21wspzxc");

// NOTE: seed bumped to v2 because the OrderBook + Fill layout changed.
pub const BOOK_SEED: &[u8] = b"book_v5";
pub const BAL_SEED: &[u8] = b"bal";
pub const VAULT_AUTH_SEED: &[u8] = b"vault";
pub const VAULT_BASE_SEED: &[u8] = b"vault_base";
pub const VAULT_QUOTE_SEED: &[u8] = b"vault_quote";

pub const MAX_ORDERS: usize = 32;
pub const MAX_FILLS: usize = 32;

pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

// ---- settlement scaling (documented, exact-integer) ----
// book `size` unit  = 0.001 base token  -> base lamports = size * 1_000_000 (wSOL has 9 decimals)
// book `price`      = quote per base x100 (e.g. 18738 = 187.38)
// quote (6-dec USDC) for a fill = price * size * 10  (micro-USDC)
//   check: price 18738, size 10 -> base 0.01 wSOL, quote 1.8738 USDC  (187.38 * 0.01) ✓
pub const BASE_LAMPORTS_PER_SIZE: u64 = 1_000_000;
pub const QUOTE_MICRO_MULT: u64 = 10;

#[ephemeral]
#[program]
pub mod shade {
    use super::*;

    /// Create the order book on the base layer + record the market's two mints.
    pub fn initialize_book(ctx: Context<InitializeBook>, tick: u64, lot: u64) -> Result<()> {
        let book = &mut ctx.accounts.book;
        book.authority = ctx.accounts.authority.key();
        book.base_mint = ctx.accounts.base_mint.key();
        book.quote_mint = ctx.accounts.quote_mint.key();
        book.seq = 1;
        book.settled_seq = 0;
        book.last_price = 0;
        book.tick = tick;
        book.lot = lot;
        book.bids = Vec::new();
        book.asks = Vec::new();
        book.fills = Vec::new();
        msg!("Shade book v2 initialized: {}", book.key());
        Ok(())
    }

    /// Create the two program-owned vault token accounts (base + quote), held by a PDA authority.
    pub fn init_vaults(_ctx: Context<InitVaults>) -> Result<()> {
        msg!("Shade vaults created");
        Ok(())
    }

    /// Create the signer's per-user balance ledger.
    pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
        let ub = &mut ctx.accounts.user_balance;
        ub.owner = ctx.accounts.owner.key();
        ub.base_free = 0;
        ub.quote_free = 0;
        ub.bump = ctx.bumps.user_balance;
        Ok(())
    }

    /// Deposit base tokens (wSOL) into the vault and credit the ledger.
    pub fn deposit_base(ctx: Context<DepositBase>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault_base.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        let ub = &mut ctx.accounts.user_balance;
        ub.base_free = ub.base_free.checked_add(amount).ok_or(BookError::MathOverflow)?;
        Ok(())
    }

    /// Deposit quote tokens (USDC) into the vault and credit the ledger.
    pub fn deposit_quote(ctx: Context<DepositQuote>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault_quote.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        let ub = &mut ctx.accounts.user_balance;
        ub.quote_free = ub.quote_free.checked_add(amount).ok_or(BookError::MathOverflow)?;
        Ok(())
    }

    /// Withdraw base tokens (wSOL) from the vault back to the user.
    pub fn withdraw_base(ctx: Context<WithdrawBase>, amount: u64) -> Result<()> {
        {
            let ub = &mut ctx.accounts.user_balance;
            ub.base_free = ub.base_free.checked_sub(amount).ok_or(BookError::InsufficientFunds)?;
        }
        let book_key = ctx.accounts.book.key();
        let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, book_key.as_ref(), &[ctx.bumps.vault_auth]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault_base.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.vault_auth.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// Withdraw quote tokens (USDC) from the vault back to the user.
    pub fn withdraw_quote(ctx: Context<WithdrawQuote>, amount: u64) -> Result<()> {
        {
            let ub = &mut ctx.accounts.user_balance;
            ub.quote_free = ub.quote_free.checked_sub(amount).ok_or(BookError::InsufficientFunds)?;
        }
        let book_key = ctx.accounts.book.key();
        let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, book_key.as_ref(), &[ctx.bumps.vault_auth]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault_quote.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.vault_auth.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// Settle the next unsettled fill: move credited balances buyer<->seller.
    /// Call repeatedly until book.settled_seq == latest fill id (frontend loops).
    /// Must run on the BASE layer after `settle_and_undelegate` brings the book home.
    pub fn settle_fill(ctx: Context<SettleFill>) -> Result<()> {
        let book = &mut ctx.accounts.book;

        // find the unsettled fill with the smallest id greater than settled_seq
        let mut idx: Option<usize> = None;
        let mut best_id = u64::MAX;
        for (i, f) in book.fills.iter().enumerate() {
            if f.id > book.settled_seq && f.id < best_id {
                best_id = f.id;
                idx = Some(i);
            }
        }
        let i = idx.ok_or(BookError::NothingToSettle)?;
        let fill = book.fills[i].clone();

        require_keys_eq!(ctx.accounts.buyer_balance.owner, fill.buyer, BookError::WrongSettleAccounts);
        require_keys_eq!(ctx.accounts.seller_balance.owner, fill.seller, BookError::WrongSettleAccounts);

        let base_amount = fill.size.checked_mul(BASE_LAMPORTS_PER_SIZE).ok_or(BookError::MathOverflow)?;
        let quote_amount = fill
            .price
            .checked_mul(fill.size)
            .and_then(|v| v.checked_mul(QUOTE_MICRO_MULT))
            .ok_or(BookError::MathOverflow)?;

        // buyer: +base, -quote   |   seller: -base, +quote
        {
            let b = &mut ctx.accounts.buyer_balance;
            b.base_free = b.base_free.checked_add(base_amount).ok_or(BookError::MathOverflow)?;
            b.quote_free = b.quote_free.checked_sub(quote_amount).ok_or(BookError::InsufficientFunds)?;
        }
        {
            let s = &mut ctx.accounts.seller_balance;
            s.base_free = s.base_free.checked_sub(base_amount).ok_or(BookError::InsufficientFunds)?;
            s.quote_free = s.quote_free.checked_add(quote_amount).ok_or(BookError::MathOverflow)?;
        }

        book.settled_seq = fill.id;
        msg!("settled fill #{} base {} quote {}", fill.id, base_amount, quote_amount);
        Ok(())
    }

    // ---------------- ER: delegation + matching (unchanged design) ----------------

    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[BOOK_SEED],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn place_order(ctx: Context<MutateBook>, side: u8, price: u64, size: u64) -> Result<()> {
        require!(side == SIDE_BID || side == SIDE_ASK, BookError::BadSide);
        require!(price > 0 && size > 0, BookError::BadParams);

        let owner = ctx.accounts.trader.key();
        let book = &mut ctx.accounts.book;
        let id = book.seq;
        book.seq = book.seq.checked_add(1).unwrap();

        let order = Order { id, owner, price, size, side };
        if side == SIDE_BID {
            require!(book.bids.len() < MAX_ORDERS, BookError::BookFull);
            book.bids.push(order);
        } else {
            require!(book.asks.len() < MAX_ORDERS, BookError::BookFull);
            book.asks.push(order);
        }
        match_engine(book)?;
        Ok(())
    }

    pub fn cancel_order(ctx: Context<MutateBook>, id: u64) -> Result<()> {
        let owner = ctx.accounts.trader.key();
        let book = &mut ctx.accounts.book;
        let before = book.bids.len() + book.asks.len();
        book.bids.retain(|o| !(o.id == id && o.owner == owner));
        book.asks.retain(|o| !(o.id == id && o.owner == owner));
        require!(before != book.bids.len() + book.asks.len(), BookError::OrderNotFound);
        Ok(())
    }

    pub fn match_book(ctx: Context<MutateBook>) -> Result<()> {
        match_engine(&mut ctx.accounts.book)?;
        Ok(())
    }

    pub fn commit_book(ctx: Context<CommitBook>) -> Result<()> {
        ctx.accounts.book.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.book.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn settle_and_undelegate(ctx: Context<CommitBook>) -> Result<()> {
        ctx.accounts.book.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.book.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

/// Price-time priority matcher. Records buyer (bid owner) & seller (ask owner) per fill.
fn match_engine(book: &mut OrderBook) -> Result<()> {
    book.bids.sort_by(|a, b| b.price.cmp(&a.price).then(a.id.cmp(&b.id)));
    book.asks.sort_by(|a, b| a.price.cmp(&b.price).then(a.id.cmp(&b.id)));

    loop {
        if book.bids.is_empty() || book.asks.is_empty() {
            break;
        }
        let best_bid = book.bids[0].clone();
        let best_ask = book.asks[0].clone();
        if best_bid.price < best_ask.price {
            break;
        }
        let fill_size = best_bid.size.min(best_ask.size);
        // maker = the resting (older) order -> its price is the fill price
        let fill_price = if best_bid.id < best_ask.id { best_bid.price } else { best_ask.price };

        let fid = book.seq;
        book.seq = book.seq.checked_add(1).ok_or(BookError::SequenceOverflow)?;
        if book.fills.len() >= MAX_FILLS {
            book.fills.remove(0);
        }
        book.fills.push(Fill {
            id: fid,
            buyer: best_bid.owner,
            seller: best_ask.owner,
            price: fill_price,
            size: fill_size,
            ts: Clock::get()?.unix_timestamp,
        });
        book.last_price = fill_price;

        book.bids[0].size -= fill_size;
        book.asks[0].size -= fill_size;
        if book.bids[0].size == 0 { book.bids.remove(0); }
        if book.asks[0].size == 0 { book.asks.remove(0); }
    }
    Ok(())
}

// ---------------- Accounts ----------------

#[derive(Accounts)]
pub struct InitializeBook<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + OrderBook::INIT_SPACE,
        seeds = [BOOK_SEED],
        bump
    )]
    pub book: Account<'info, OrderBook>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitVaults<'info> {
    #[account(mut, seeds = [BOOK_SEED], bump)]
    pub book: Account<'info, OrderBook>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(address = book.base_mint)]
    pub base_mint: Account<'info, Mint>,
    #[account(address = book.quote_mint)]
    pub quote_mint: Account<'info, Mint>,
    /// CHECK: PDA authority over both vaults
    #[account(seeds = [VAULT_AUTH_SEED, book.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(
        init, payer = payer,
        seeds = [VAULT_BASE_SEED, book.key().as_ref()], bump,
        token::mint = base_mint, token::authority = vault_auth
    )]
    pub vault_base: Account<'info, TokenAccount>,
    #[account(
        init, payer = payer,
        seeds = [VAULT_QUOTE_SEED, book.key().as_ref()], bump,
        token::mint = quote_mint, token::authority = vault_auth
    )]
    pub vault_quote: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitUser<'info> {
    /// CHECK: book PDA — used only for seed derivation, never deserialized (may be delegated to the rollup)
    #[account(seeds = [BOOK_SEED], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(
        init, payer = owner,
        space = 8 + UserBalance::INIT_SPACE,
        seeds = [BAL_SEED, book.key().as_ref(), owner.key().as_ref()], bump
    )]
    pub user_balance: Account<'info, UserBalance>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositBase<'info> {
    /// CHECK: book PDA — used only for seed derivation, never deserialized (may be delegated to the rollup)
    #[account(seeds = [BOOK_SEED], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [BAL_SEED, book.key().as_ref(), owner.key().as_ref()], bump = user_balance.bump)]
    pub user_balance: Account<'info, UserBalance>,
    #[account(mut, seeds = [VAULT_BASE_SEED, book.key().as_ref()], bump)]
    pub vault_base: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DepositQuote<'info> {
    /// CHECK: book PDA — used only for seed derivation, never deserialized (may be delegated to the rollup)
    #[account(seeds = [BOOK_SEED], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [BAL_SEED, book.key().as_ref(), owner.key().as_ref()], bump = user_balance.bump)]
    pub user_balance: Account<'info, UserBalance>,
    #[account(mut, seeds = [VAULT_QUOTE_SEED, book.key().as_ref()], bump)]
    pub vault_quote: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawBase<'info> {
    /// CHECK: book PDA — used only for seed derivation, never deserialized (may be delegated to the rollup)
    #[account(seeds = [BOOK_SEED], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [BAL_SEED, book.key().as_ref(), owner.key().as_ref()], bump = user_balance.bump)]
    pub user_balance: Account<'info, UserBalance>,
    /// CHECK: PDA authority over the vaults
    #[account(seeds = [VAULT_AUTH_SEED, book.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(mut, seeds = [VAULT_BASE_SEED, book.key().as_ref()], bump)]
    pub vault_base: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawQuote<'info> {
    /// CHECK: book PDA — used only for seed derivation, never deserialized (may be delegated to the rollup)
    #[account(seeds = [BOOK_SEED], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(mut, seeds = [BAL_SEED, book.key().as_ref(), owner.key().as_ref()], bump = user_balance.bump)]
    pub user_balance: Account<'info, UserBalance>,
    /// CHECK: PDA authority over the vaults
    #[account(seeds = [VAULT_AUTH_SEED, book.key().as_ref()], bump)]
    pub vault_auth: UncheckedAccount<'info>,
    #[account(mut, seeds = [VAULT_QUOTE_SEED, book.key().as_ref()], bump)]
    pub vault_quote: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleFill<'info> {
    #[account(mut, seeds = [BOOK_SEED], bump)]
    pub book: Account<'info, OrderBook>,
    // PDA-owned UserBalance accounts; matched to the fill by owner-key check in the handler.
    #[account(mut)]
    pub buyer_balance: Account<'info, UserBalance>,
    #[account(mut)]
    pub seller_balance: Account<'info, UserBalance>,
    pub cranker: Signer<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the PDA to delegate (the order book)
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MutateBook<'info> {
    #[account(mut, seeds = [BOOK_SEED], bump)]
    pub book: Account<'info, OrderBook>,
    pub trader: Signer<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BOOK_SEED], bump)]
    pub book: Account<'info, OrderBook>,
}

// ---------------- State ----------------

#[account]
#[derive(InitSpace)]
pub struct OrderBook {
    pub authority: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub seq: u64,
    pub settled_seq: u64,
    pub last_price: u64,
    pub tick: u64,
    pub lot: u64,
    #[max_len(32)]
    pub bids: Vec<Order>,
    #[max_len(32)]
    pub asks: Vec<Order>,
    #[max_len(32)]
    pub fills: Vec<Fill>,
}

#[account]
#[derive(InitSpace)]
pub struct UserBalance {
    pub owner: Pubkey,
    pub base_free: u64,
    pub quote_free: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Order {
    pub id: u64,
    pub owner: Pubkey,
    pub price: u64,
    pub size: u64,
    pub side: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Fill {
    pub id: u64,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub size: u64,
    pub ts: i64,
}

#[error_code]
pub enum BookError {
    #[msg("side must be 0 (bid) or 1 (ask)")]
    BadSide,
    #[msg("price and size must be > 0")]
    BadParams,
    #[msg("order book side is full")]
    BookFull,
    #[msg("order not found or not owned by signer")]
    OrderNotFound,
    #[msg("order book sequence overflow")]
    SequenceOverflow,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("insufficient credited balance")]
    InsufficientFunds,
    #[msg("no unsettled fills remain")]
    NothingToSettle,
    #[msg("buyer/seller balance accounts do not match the next fill")]
    WrongSettleAccounts,
}