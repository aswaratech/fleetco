// Re-export shim. The pipe moved to apps/api/src/common/zod-validation.pipe.ts
// in iter 6 (Drivers slice) when it acquired a second consumer, per
// docs/runbook/api-error-mapping.md §"How to implement the mapping in a
// new module". Vehicles continues to work via this shim so iter-5 test
// imports do not churn; new modules should import directly from
// `apps/api/src/common/zod-validation.pipe`. The shim is safe to delete
// once the next slice that touches Vehicles updates its imports inline.
export { ZodValidationPipe } from "../../common/zod-validation.pipe";
