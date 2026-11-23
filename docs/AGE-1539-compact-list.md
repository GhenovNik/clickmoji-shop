# AGE-1539: compact shopping list

Source: Linear AGE-1539, including the operator's comments of 2026-11-03. This
review checklist records the task requirements for PR #114; it does not replace
the issue or its attached mockups.

**AC-1** The list header places the name and remaining count together, and search
and text import together. The bottom actions place Add items and Clear all on one
row, with purchase history below.

**AC-2** Pending items are grouped into collapsible categories with a count and
chevron. The list view uses compact rows; at 375 × 812 the seven-item fixture's
To buy block fits above the fixed navigation without scrolling.

**AC-3** A labelled, accessible control switches between list and grid without a
hidden duplicate item tree. Grid has two columns on mobile and may use three from
medium screens. Desktop content is constrained to max-w-2xl.

**AC-4** Purchased items appear in an independently collapsible light-green section,
grouped by category with struck-through names and a green check. Controls expose
expanded and selected state; new labels are available in Russian and English.

**AC-5** View and collapsed groups persist on the device; unavailable or malformed
localStorage falls back safely to list view and expanded groups.

**AC-6** In both views only the purchase circle toggles purchase state and notes can
be expanded completely. Focus survives movement and server reconciliation without
stealing focus after the user deliberately moves elsewhere.

**AC-7** On mobile, a horizontal swipe on a row or tile offers confirmation before
removal; there is no visible or invisible cross target. On desktop the visible cross
also requires confirmation. Keyboard and screen-reader users have an accessible
alternative on every width. Swipe must not conflict with vertical scrolling, purchase
or note expansion. Undo is optional if confirmation is present.

**INV-1** Preserve master purchase delivery and row-lock behaviour: a busy row is
locked during writes, retries and required server reloads; other rows remain usable;
a failed write reconciles against a fresh server read rather than a client snapshot.
Preserve confirmed changes if a later reload fails.

**INV-2** Local browser evidence uses synthetic data and never production services.
Capture list and grid at widths 375, 1280 and 1440 for review.
