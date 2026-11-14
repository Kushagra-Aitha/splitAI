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

C7 is integrated with C3's real persisted Guard blocks. The dialog focus trap
excludes controls disabled by a parent fieldset. Responses do not take focus
away from a new message being typed, and goal saves expose an explicit status.

The production build passed during implementation. At the user's explicit
request, no further tests or browser verification were run before merging C7.
Keyboard/screen-reader behavior and mobile layouts have not been independently
verified in a browser. No automated browser-test dependency is required by this
change.
