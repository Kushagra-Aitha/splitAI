# Ask accessibility groundwork (C7)

The composer has a localized focus-within halo and retains its keyboard outline.
Responses are labelled regions with busy state; errors are atomic alerts linked
to their selection forms. When an active control is re-rendered, its stable ID
restores focus and text selection where possible. Async results focus their
response/error only if the user has not moved focus to another control.

Expense selections retain the entered merchant, exact amount and chosen people
after an error. Cached participants are tied to the group whose member list was
shown, so switching groups uses the new authoritative suggestions. The payer
remains checked and is still enforced by the server. Ask and Together both use
the same shared ticket, whose confirm/discard controls disable while confirming
and expose saving/error state.

Narrow-screen styles stack the detail fields, preserve readable input text,
provide larger member-label targets, and wrap long ticket/plan content. Goals
also retains focus across data refreshes and stacks its monetary fields.

The production build passes. These are independent C7 changes; issue #27 remains
open. Runtime keyboard/screen-reader behavior and mobile widths still need
browser verification. The browser tools repeatedly returned stale-state,
missing-frame, and missing-window errors during local checks. Guard blocked
states remain dependent on A9/C3; no fake event or blocked response is introduced.
