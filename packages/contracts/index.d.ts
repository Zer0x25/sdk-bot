import type { components } from './generated';
export type { components, paths, operations } from './generated';
export type ContractName = keyof components['schemas'];
export type Contract<N extends ContractName> = components['schemas'][N];
export interface ValidationIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
}
export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: ValidationIssue[] };
export function validate<N extends ContractName>(name: N, value: unknown): ValidationResult<Contract<N>>;
export function assertValid<N extends ContractName>(name: N, value: unknown): Contract<N>;
