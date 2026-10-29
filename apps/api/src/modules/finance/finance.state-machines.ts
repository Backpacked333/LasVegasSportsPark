import { defineStateMachine } from '@sportspark/contracts';

/**
 * Finance Package G lifecycles (§4.6 "every command defines its allowed source state"; FIN-06
 * point of sale, FIN-07 accounting export). The database guards of migrations 0607 and 0608
 * (`pos_products_guard`, `pos_registers_guard`, `pos_register_sessions_guard`, `pos_sales_guard`,
 * `pos_tenders_guard`, `accounting_mappings_guard`, `accounting_export_batches_guard`) refuse
 * exactly the transitions these machines refuse. Sale lines and returns are append-only facts.
 */

export type PosProductState = 'active' | 'retired';
export type PosProductEvent = 'retire';
export const PosProductMachine = defineStateMachine<PosProductState, PosProductEvent>({
  name: 'PosProduct',
  initial: 'active',
  states: ['active', 'retired'],
  terminal: ['retired'],
  transitions: { active: { retire: 'retired' }, retired: {} },
});

export type PosRegisterState = 'active' | 'retired';
export type PosRegisterEvent = 'retire';
export const PosRegisterMachine = defineStateMachine<PosRegisterState, PosRegisterEvent>({
  name: 'PosRegister',
  initial: 'active',
  states: ['active', 'retired'],
  terminal: ['retired'],
  transitions: { active: { retire: 'retired' }, retired: {} },
});

export type PosRegisterSessionState = 'open' | 'closed';
export type PosRegisterSessionEvent = 'close';
export const PosRegisterSessionMachine = defineStateMachine<
  PosRegisterSessionState,
  PosRegisterSessionEvent
>({
  name: 'PosRegisterSession',
  initial: 'open',
  states: ['open', 'closed'],
  terminal: ['closed'],
  transitions: { open: { close: 'closed' }, closed: {} },
});

export type PosSaleState = 'open' | 'paid' | 'voided' | 'partially_returned' | 'returned';
export type PosSaleEvent = 'pay' | 'void' | 'return_part' | 'return_all';
export const PosSaleMachine = defineStateMachine<PosSaleState, PosSaleEvent>({
  name: 'PosSale',
  initial: 'open',
  states: ['open', 'paid', 'voided', 'partially_returned', 'returned'],
  terminal: ['voided', 'returned'],
  transitions: {
    open: { pay: 'paid', void: 'voided' },
    paid: { return_part: 'partially_returned', return_all: 'returned' },
    partially_returned: { return_part: 'partially_returned', return_all: 'returned' },
    voided: {},
    returned: {},
  },
});

/** A card tender waits for the provider; cash and external tenders are settled when recorded. */
export type PosTenderState = 'pending' | 'settled' | 'failed';
export type PosTenderEvent = 'settle' | 'fail';
export const PosTenderMachine = defineStateMachine<PosTenderState, PosTenderEvent>({
  name: 'PosTender',
  initial: 'pending',
  states: ['pending', 'settled', 'failed'],
  terminal: ['settled', 'failed'],
  transitions: { pending: { settle: 'settled', fail: 'failed' }, settled: {}, failed: {} },
});

export type AccountingMappingState = 'proposed' | 'approved' | 'retired';
export type AccountingMappingEvent = 'approve' | 'withdraw' | 'retire';
export const AccountingMappingMachine = defineStateMachine<
  AccountingMappingState,
  AccountingMappingEvent
>({
  name: 'AccountingMapping',
  initial: 'proposed',
  states: ['proposed', 'approved', 'retired'],
  terminal: ['retired'],
  transitions: {
    proposed: { approve: 'approved', withdraw: 'retired' },
    approved: { retire: 'retired' },
    retired: {},
  },
});

export type AccountingExportBatchState =
  'prepared' | 'submitted' | 'accepted' | 'rejected' | 'unknown' | 'canceled';
export type AccountingExportBatchEvent = 'submit' | 'cancel' | 'accept' | 'reject' | 'lose';
export const AccountingExportBatchMachine = defineStateMachine<
  AccountingExportBatchState,
  AccountingExportBatchEvent
>({
  name: 'AccountingExportBatch',
  initial: 'prepared',
  states: ['prepared', 'submitted', 'accepted', 'rejected', 'unknown', 'canceled'],
  terminal: ['accepted', 'rejected', 'canceled'],
  transitions: {
    prepared: { submit: 'submitted', cancel: 'canceled' },
    submitted: { accept: 'accepted', reject: 'rejected', lose: 'unknown' },
    unknown: { accept: 'accepted', reject: 'rejected' },
    accepted: {},
    rejected: {},
    canceled: {},
  },
});
