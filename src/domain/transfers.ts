import type { TransferData } from '../shared/contracts.js';
import imported from '../../config/transfers.json';

// Published minima already include the suggested buffer; add only personal extra time.
export const transfers: TransferData = imported;
