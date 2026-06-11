use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

// Replace with your own program id via `anchor keys sync` after first build.
declare_id!("6BzNCF1GWjyRfaHF7ZuVaSu4CQjquHwdL5GFvBh6BoXK");

pub const BOOK_SEED: &[u8] = b"orderbook";
pub const MAX_ORDERS: usize = 32;
pub const MAX_FILLS: usize = 32;

pub const SIDE_BID: u8 = 0;
pub const SIDE_ASK: u8 = 1;

#[ephemeral]
#[program]
pub mod shade {
    use super::*;

    /// Create the order book on the base layer (Solana mainnet/devnet).
    /// `tick` and `lot` are purely informational scaling hints for the UI.
    pub fn initialize_book(ctx: Context<InitializeBook>, tick: u64, lot: u64) -> Result<()> {
        let book = &mut ctx.accounts.book;
        book.authority = ctx.accounts.authority.key();
        book.seq = 1;
        book.last_price = 0;
        book.tick = tick;
        book.lot = lot;
        book.bids = Vec::new();
        book.asks = Vec::new();
        book.fills = Vec::new();
        msg!("Shade book initialized: {}", book.key());
        Ok(())
    }

    /// Delegate the book PDA to the Ephemeral Rollup.
    /// After this, the book becomes unusable on the base layer and all
    /// place/cancel/match traffic flows through the ER at low latency.
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[BOOK_SEED],
            DelegateConfig {
                // Optional: pin a specific ER validator passed as the first remaining account.
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Place a limit order. Runs on the ER (gasless, sub-10ms).
    /// The order is invisible to the base layer until the book is committed.
    /// Matching runs inline so a single tx can place + cross + fill.
    pub fn place_order(ctx: Context<MutateBook>, side: u8, price: u64, size: u64) -> Result<()> {
        require!(side == SIDE_BID || side == SIDE_ASK, BookError::BadSide);
        require!(price > 0 && size > 0, BookError::BadParams);

        let owner = ctx.accounts.trader.key();
        let book = &mut ctx.accounts.book;
        let id = book.seq;
        book.seq = book.seq.checked_add(1).unwrap();

        let order = Order {
            id,
            owner,
            price,
            size,
            side,
        };

        if side == SIDE_BID {
            require!(book.bids.len() < MAX_ORDERS, BookError::BookFull);
            book.bids.push(order);
        } else {
            require!(book.asks.len() < MAX_ORDERS, BookError::BookFull);
            book.asks.push(order);
        }

        match_engine(book)?;
        msg!("placed order #{} side {} px {} sz {}", id, side, price, size);
        Ok(())
    }

    /// Cancel a resting order by id. Runs on the ER.
    pub fn cancel_order(ctx: Context<MutateBook>, id: u64) -> Result<()> {
        let owner = ctx.accounts.trader.key();
        let book = &mut ctx.accounts.book;
        let before = book.bids.len() + book.asks.len();
        book.bids.retain(|o| !(o.id == id && o.owner == owner));
        book.asks.retain(|o| !(o.id == id && o.owner == owner));
        require!(before != book.bids.len() + book.asks.len(), BookError::OrderNotFound);
        msg!("cancelled order #{}", id);
        Ok(())
    }

    /// Run the matching engine. Designed to be triggered by an ER crank
    /// (e.g. every 250ms) so the book continuously clears crossing orders.
    pub fn match_book(ctx: Context<MutateBook>) -> Result<()> {
        match_engine(&mut ctx.accounts.book)?;
        Ok(())
    }

    /// Commit the book state from the ER back to the base layer without
    /// undelegating. This is the "settlement heartbeat": the public chain
    /// learns the new book + fills, but the book stays live on the ER.
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

    /// Final settlement: commit the book and undelegate it back to the base
    /// layer (book becomes usable on-chain again).
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

/// Price-time priority matching engine.
/// Bids sorted high->low, asks low->high. Cross while best_bid >= best_ask.
/// Fills are recorded at the resting (maker) price = the ask price here, which
/// is the conventional taker-crosses-the-book convention for this demo.
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
        let fill_price = best_ask.price;
        let fid = book.seq;
        book.seq = book.seq.checked_add(1).unwrap();

        if book.fills.len() >= MAX_FILLS {
            book.fills.remove(0);
        }
        book.fills.push(Fill {
            id: fid,
            maker: best_ask.owner,
            taker: best_bid.owner,
            price: fill_price,
            size: fill_size,
            ts: Clock::get()?.unix_timestamp,
        });
        book.last_price = fill_price;

        book.bids[0].size -= fill_size;
        book.asks[0].size -= fill_size;
        if book.bids[0].size == 0 {
            book.bids.remove(0);
        }
        if book.asks[0].size == 0 {
            book.asks.remove(0);
        }
    }
    Ok(())
}

// ---------- Accounts ----------

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
    pub system_program: Program<'info, System>,
}

/// Injects the delegation accounts via the #[delegate] macro.
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the PDA to delegate (the order book)
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

/// Used for place / cancel / match on the ER.
#[derive(Accounts)]
pub struct MutateBook<'info> {
    #[account(mut, seeds = [BOOK_SEED], bump)]
    pub book: Account<'info, OrderBook>,
    /// The trader (signer on the ER). For crank-driven match this can be any signer.
    pub trader: Signer<'info>,
}

/// Used for commit / undelegate. The #[commit] macro injects magic_context + magic_program.
#[commit]
#[derive(Accounts)]
pub struct CommitBook<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [BOOK_SEED], bump)]
    pub book: Account<'info, OrderBook>,
}

// ---------- State ----------

#[account]
#[derive(InitSpace)]
pub struct OrderBook {
    pub authority: Pubkey,
    pub seq: u64,
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
    pub maker: Pubkey,
    pub taker: Pubkey,
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
}
