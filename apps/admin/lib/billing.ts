export const money = (c: number | string) => `$${(Number(c) / 100).toFixed(2)}`;
export const INVOICE_TONE: Record<string, 'neutral' | 'info' | 'success' | 'danger'> = { draft: 'neutral', issued: 'info', paid: 'success', void: 'danger' };
