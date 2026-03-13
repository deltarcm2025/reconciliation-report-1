export interface SafeBalanceRecord {
  examDate: string;
  patientFirst: string;
  patientLast: string;
  dob: string;
  provider: string;
}

export interface OfficeAllyRecord {
  claimId: string;
  provider: string;
  payer: string;
  patientName: string; // "Last, First"
  patientId: string;
  cpt: string;
  units: string;
  dos: string;
  dob?: string; // Added DOB
  charge: string;
  paid: string;
  status: string;
}

export interface ReconciledRecord {
  id: string; // Added unique ID for tracking
  patientName: string;
  dob: string;
  provider: string;
  safeBalance?: SafeBalanceRecord;
  officeAlly?: OfficeAllyRecord;
  matchType: 'both' | 'done_not_billed' | 'billed_not_done';
  matchConfidence: 'exact' | 'partial' | 'none';
  matchReason?: string;
  isConfirmed?: boolean; // User manually confirmed this partial match
  isCrossProvider?: boolean; // Matched but under a different provider
  unitInfo?: {
    totalUnits: number;
    isMismatch: boolean;
    details: string;
  };
  paymentStatus: 'Paid' | 'Unpaid' | 'Pending' | 'N/A';
  payerMode?: number;
  isBelowMode?: boolean;
}

export interface PayerAnalysis {
  payer: string;
  mode: number;
  avgPaid: number;
  minPaid: number;
  maxPaid: number;
  count: number;
}

export interface ReconciliationSummary {
  totalDone: number;
  totalBilled: number; // Unique billing events
  rawBilledRows?: number; // Total input rows from Office Ally
  bothCount: number;
  potentialMatchCount: number;
  doneNotBilledCount: number;
  billedNotDoneCount: number;
  totalPaid: number;
  totalUnpaid: number;
  totalCollected: number;
  totalCharged: number;
  payerAnalysis: PayerAnalysis[];
}
