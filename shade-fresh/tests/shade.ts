import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ShadeClient,
  makeProviders,
  SIDE_BID,
  SIDE_ASK,
} from "../app/src/lib/shade";

describe("shade", () => {
  const wallet = anchor.Wallet.local();
  const { baseProvider, erProvider } = makeProviders(wallet);
  anchor.setProvider(baseProvider);

  const idl = anchor.workspace.Shade.idl as anchor.Idl;
  const client = new ShadeClient(idl, baseProvider, erProvider);

  it("initializes the book", async () => {
    try {
      await client.initializeBook(100, 1);
    } catch (_) {}
    const b = await client.fetchBookBase();
    assert.ok(b.seq >= 1);
  });

  it("delegates to the ER", async () => {
    await client.delegate();
    await new Promise((r) => setTimeout(r, 3000));
  });

  it("places + crosses orders on the ER", async () => {
    await client.placeOrder(SIDE_ASK, 18738, 15);
    await client.placeOrder(SIDE_BID, 18742, 12); // crosses
    const b = await client.fetchBookER();
    assert.ok(b.fills.length >= 1, "expected at least one fill");
    assert.equal(b.lastPrice, 18738);
  });

  it("commits ER state back to the base layer", async () => {
    await client.commitBook();
    const b = await client.fetchBookBase();
    assert.equal(b.lastPrice, 18738);
  });

  it("settles + undelegates", async () => {
    await client.settleAndUndelegate();
  });
});
