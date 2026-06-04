# Cache model: disjoint `inputTokens` and `savedTokens` on Request

The codebase had two competing cache models in the same render path. The cost formula used `billedInput = inputTokens - savedTokens` (subset model); the displayed Cache Hit Rate used `(savedTokens / (inputTokens + savedTokens))` (disjoint model). The two are mathematically incompatible — under the subset model the rate formula caps at 50%, under the disjoint model it caps at 100%. We adopt the disjoint model: `Request.inputTokens` and `Request.savedTokens` are separate, non-overlapping fields. `billedInput` is no longer a derived field; `Request.inputTokens` is by definition the billed input.

## Status

Accepted, **applied in code**. We have resolved the cache model inconsistency by adopting the disjoint model throughout the code path. All cost calculations (`addRequest`, `fetchRealRTKData`, `connectRTKStream`, `generateInitialMockHistory`) use disjoint parameters directly, where `inputTokens` is by definition the billed amount.

## Considered Options

- **Subset model: `savedTokens ⊆ inputTokens`, rate = `saved / input`.** Matches the original cost formula; required fixing the displayed rate.
- **Disjoint model: `savedTokens ∩ inputTokens = ∅`, rate = `saved / (input + saved)`.** Matches the original displayed rate; required fixing the cost formula.
- **Disjoint model with explicit `billedInput` (chosen).** Schema change: `billedInput` is removed as a derived field. `inputTokens` is the billed amount by definition. Cost = `(inputTokens * inputRate + outputTokens * outputRate) / 1M`. Savings = `savedTokens * inputRate / 1M`. Cache Hit Rate = `saved / (input + saved)`.

## Consequences (once applied)

- The Request schema is canonicalised: `id`, `timestamp`, `brand`, `inputTokens`, `outputTokens`, `savedTokens`, `cost`, `savings`. `billedInput` is gone.
- The simulator's `billedInput = Math.max(0, inputTokens - savedTokens)` line is deleted; `inputTokens` is generated directly as the billed amount.
- Cost = `(inputTokens * inputRate + outputTokens * outputRate) / 1M`, regardless of how many tokens were "saved". This is intentional: under the disjoint model, the saved tokens never reached the LLM's input meter, so they were never billed.
- The Cache Hit Rate displayed in the UI is meaningful at 0-100%.

## Why "not yet applied"

The current cost formula uses `billedInput`, and switching to disjoint semantics changes the cost value for any synthetic Request whose `savedTokens` was derived from `inputTokens`. The simulator and the pre-populated mock history are both still in the subset model. A clean implementation requires regenerating the simulator to emit disjoint fields directly (the `triggerRandomMockRequest` and `generateInitialMockHistory` flows). This is tracked as a code task in `docs/REVIEWS.md` R3.
