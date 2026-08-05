# UI design brief — spidey

A design brief, not a spec. Layout below is a starting point, not a constraint — the content hierarchy and the constraints in §7 are what matter.

---

## 1. What this is

A ranking tool for USDC liquidity providers. It answers one question: **"where should I actually put my USDC, given how much I have?"**

The answer is different from what every dashboard shows, and the interface exists to make that difference obvious.

## 2. Why it exists

Aggregators compute APR as `fees ÷ displayed TVL`. Two things break that:

- Only **in-range** liquidity earns fees. Often 0.5–8% of what's displayed.
- **Your own deposit** joins the denominator. A pool paying 900% on $8k pays far less once you add $5k.

Real numbers from live data:

| Pool | Displayed TVL | Actually earning | Share |
|---|---:|---:|---:|
| SOL/USDC (Orca) | $25.5M | $115k | 0.45% |
| WETH/USDC (Uniswap, Base) | $112M | $8.76M | 7.81% |
| USDC/USDT (Orca) | $1.18M | $638k | 53.9% |

The spread is the point: one headline number cannot rank these.

## 3. Who it's for

| | |
|---|---|
| **Primary** | USDC holders with enough size that they move the pool ($10k+). They've been burned by a headline APR. |
| **Secondary** | Anyone comparing LP venues who suspects the numbers are wrong. |
| **Not** | Yield farmers hunting emissions. Traders. Anyone under ~$1k, where every venue is roughly equivalent. |

**Tone:** blunt, numerate, no hype. This product's credibility comes from refusing to show numbers it can't defend. Never oversell.

## 4. The one thing to get right

> **The user types an amount. The ranking reorders.**

Nothing else matters as much. No submit button, no page transition — the reorder must feel like a direct consequence of typing. If a designer optimises one interaction, it's this one.

---

## 5. Screens

### 5.1 Header

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◈ spidey        How it works    Docs           [ Connect Wallet ]   │
└──────────────────────────────────────────────────────────────────────┘
```

Wallet is optional. Everything except depositing works without it — do not gate browsing behind a connect.

### 5.2 Hero

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   Real USDC LP yield, for your size.                                 │
│                                                                      │
│   Dashboards divide fees by displayed TVL.                           │
│   Only in-range liquidity earns. Your deposit dilutes it.            │
│                                                                      │
│              $25.5M shown  →  $115k actually earning                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

That `$25.5M → $115k` line is the strongest asset on the page. It should be live data, not a static image, and it should be legible at a glance.

### 5.3 Input

Only **one** input is required. Everything else has a defensible default.

```
┌──────────────────────────────────────────────────────────────────────┐
│   How much are you depositing?                                       │
│                                                                      │
│      $ [ 10,000                          ]                           │
│                                                                      │
│      1k    ▄10k▄    100k    1M    10M                                │
│                                                                      │
│   ▾ more                                                             │
│     hold    [ 7 ] days      ← sets the cost-payback hurdle           │
│     pairs   (•) stable   ( ) all                                     │
└──────────────────────────────────────────────────────────────────────┘
```

- Numeric input, large type, tabular figures.
- Presets are the primary path; typing is the power path.
- `hold` and `pairs` collapse — most users never touch them.
- Debounce ~200ms. Never show a spinner on re-rank; the previous result stays visible.

### 5.4 Comparison

```
┌──────────────────────────────────────────────────────────────────────┐
│   Dashboard says          You'd get                                  │
│                                                                      │
│   101,764%        →       5.53%                                      │
│   RLUSD/USDC              USDC/USDT                                  │
│                                                                      │
│   ⚠ Different pool.                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

Show only when the two disagree. When they agree, this block is noise — hide it.

### 5.5 Results

```
┌──────────────────────────────────────────────────────────────────────┐
│   USDC/USDT  orca     5.53%  ●●●   $638k of $1.18M in range          │
│   hyUSD/USDC orca     9.88%  ●●○   your size dilutes                 │
│                                                                      │
│   27 hidden — can't be measured                              ▾ show  │
└──────────────────────────────────────────────────────────────────────┘
```

One line per pool. Confidence as dots, detail on tap:

| | meaning |
|---|---|
| `●●●` | measured in-range liquidity, observed volume |
| `●●○` | measured liquidity, modelled volume distribution |
| `●○○` | current-tick liquidity only, narrow validity |

Hidden pools collapse to a count. Expanding shows each with its reason — never a number.

### 5.6 How it works

```
    1 ──────► 2 ──────► 3 ──────► 4

    Read      Measure   Rank      Route
    every     what's    for YOUR  only if it
    pool      in range  size      pays back

    Can't measure a pool?  We hide it.
    A guessed number is the bug we exist to fix.
```

### 5.7 Wallet

```
   BEFORE                          AFTER
   ┌──────────────────┐            ┌──────────────────┐
   │ [ Connect Wallet]│    ──►     │ ◉ 0xE770…0e4A    │
   └──────────────────┘            │   $13.17 USDC    │
                                   └──────────────────┘
   browse only                     deposit unlocked
```

Once connected, each row grows an action:

```
│   USDC/USDT   orca   5.53%   ●●●        [ Deposit $10,000 ]          │
```

### 5.8 Deposit

```
   ┌────────────────────────────────────┐
   │  Deposit $10,000                   │
   │                                    │
   │  You get     10,000 spUSDC         │
   │  Exit        request → ~1 epoch    │
   │  Gas         $0.001                │
   │                                    │
   │  ⚠ Exits are not instant.          │
   │                                    │
   │  [ Approve ]  →  [ Deposit ]       │
   └────────────────────────────────────┘
```

Two transactions (approve, then deposit). Show both up front; do not surprise the user with a second signature.

### 5.9 Exit

```
   [ Request exit ]  ──►  wait for epoch  ──►  [ Claim ]
        │                       │                   │
   shares burn            capital returns      USDC lands
   amount locked          from the venue
```

```
   ⓘ Why two steps?
     Your USDC may be in a pool on another chain.
     It can't come back in one transaction.
```

This is the most likely place to lose a user's trust. The asynchrony is real and unavoidable — explain it before they commit, not after.

---

## 6. States

```
   loading     ░░░░░░░░  ░░░░  ░░░       skeleton rows, layout holds
               ░░░░░░░░  ░░░░  ░░░

   re-ranking  (keep previous results visible — no spinner)

   engine down ⚠  Engine offline                     [ retry ]

   empty       📥  Nothing measurable right now      [ refresh ]
               We exclude rather than approximate.

   wrong chain ⚠  Switch to Arc                      [ switch ]
```

---

## 7. Hard constraints

These are properties of the system, not preferences.

1. **Arc pays gas in USDC.** Chain id `5042002`. Most wallets don't have it — connect must offer *add network*, then *switch*, before anything else.
2. **Exits are asynchronous.** `request → settle → claim`. There is no instant withdraw and the UI must never imply one.
3. **Hidden pools stay hidden.** A pool without measurable in-range liquidity gets a reason, never an estimated number. This rule is the product.
4. **Ranking is a function of size.** Any cached or shared view must carry the size it was computed for, or it is meaningless.
5. **Losses are shared pro-rata.** If the vault is under-covered, claims are haircut. Surface `coverageBps` when it is below 100% — never let a user discover it at claim time.

## 8. Data available

`GET /compare?size=&hold=&stable=` returns, per pool:

```
poolId  chain  dex  pair
headlineAprBps      what dashboards show
yourAprBps          what this size actually earns
normalizedAprBps    restated at a common ±0.1% width
deltaBps            the range width used
tvlUsd              displayed
activeTvlUsd        in range  (null = unmeasurable)
activeTvlShare      the ratio that makes the point
dilution            fraction of pool yield surviving your deposit
excluded  flags[]  reason
```

`flags` drive the confidence dots and the chips. `reason` is pre-written, user-facing prose — display it verbatim.

## 9. Build status

| | |
|---|---|
| Built | header nav, hero, input, comparison, results, hidden-pool panel, all states |
| Not built | wallet connect, deposit, exit, chain switching — the app only calls the HTTP API today |

Contracts are live and source-verified on Arc; nothing in the browser reaches them yet.

## 10. Reference

Stack: Next.js App Router, Tailwind, shadcn/ui tokens, `lucide-react`. Neutral palette (brand deferred — see `brand.md`). Dark mode required. Numeric cells use tabular figures so digits don't shift on re-rank.
