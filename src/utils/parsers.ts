import { OfficeAllyRecord, SafeBalanceRecord } from '../types';

/**
 * Parses Office Ally Patient Visit Report text (OCR output).
 */
export const parseOfficeAllyText = (text: string): OfficeAllyRecord[] => {
  const records: OfficeAllyRecord[] = [];
  const lines = text.split('\n');
  
  let currentPatient = '';
  let currentDob = '';
  let currentPayer = '';
  let currentProvider = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Detect Patient header
    // Example: Patient: GARCIA, ANTOINETTE Patient ID: 152561098 Sex: F DOB: 10/16/1946
    if (line.startsWith('Patient:')) {
      const nameMatch = line.match(/Patient:\s*([^P]+)/);
      if (nameMatch) currentPatient = nameMatch[1].trim();
      
      const dobMatch = line.match(/DOB:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (dobMatch) currentDob = dobMatch[1];
      continue;
    }

    // Detect Insurance/Provider header
    // Example: Insurance: HUMANA Provider: Erica Benson, DPM Office: Sun Health
    if (line.startsWith('Insurance:')) {
      const insMatch = line.match(/Insurance:\s*([^P]+)/);
      if (insMatch) currentPayer = insMatch[1].trim();
      
      const provMatch = line.match(/Provider:\s*([^O]+)/);
      if (provMatch) currentProvider = provMatch[1].trim();
      continue;
    }

    // Detect Data row
    // Example: 11/4/2025 21 28003 80 1 $3,593.00 $0.00 $0.00 $0.00 $3,593.00
    // Pattern: Date POS CPT [Modifiers] Units Charges Insurance Patient Adj Balance
    // We use a more flexible regex to handle optional modifiers and varying whitespace
    const dataMatch = line.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d+)\s+([A-Z0-9]{5,6})\s+(?:.*?\s+)?(\d+)\s+\$([\d,.]+)\s+[\(\$]*([\d,.]+)\)*\s+\$([\d,.]+)\s+[\(\$]*([\d,.]+)\)*\s+\$([\d,.]+)/);
    
    if (dataMatch) {
      const [_, dos, pos, cpt, units, charge, paidRaw, patientPaid, adj, balance] = dataMatch;
      
      // Handle negative amounts in parentheses (e.g. ($2.60))
      const isPaidNegative = line.includes(`($${paidRaw})`);
      const paid = isPaidNegative ? `-${paidRaw}` : paidRaw;

      records.push({
        claimId: `text-${records.length}-${dos}-${cpt}`,
        provider: currentProvider,
        payer: currentPayer,
        patientName: currentPatient,
        patientId: '',
        cpt,
        units,
        dos,
        dob: currentDob,
        charge,
        paid,
        status: parseFloat(paid.replace(/[^0-9.-]+/g, '')) > 0 ? 'Paid' : 'Unpaid'
      });
    }
  }

  return records;
};

/**
 * Parses Safe Balance tab-separated or space-separated text.
 */
export const parseSafeBalanceText = (text: string): SafeBalanceRecord[] => {
  const records: SafeBalanceRecord[] = [];
  const lines = text.split('\n');
  
  for (let line of lines) {
    line = line.trim();
    if (!line || line.toLowerCase().includes('exam date')) continue;

    // Try tab separation first
    let parts = line.split('\t');
    if (parts.length < 5) {
      // Fallback to multiple spaces
      parts = line.split(/\s{2,}/);
    }
    
    // If still not enough parts, try single space but only if it looks like a valid row
    // Format: Date First Last DOB Provider...
    if (parts.length < 5) {
      const singleSpaceParts = line.split(/\s+/);
      if (singleSpaceParts.length >= 5) {
        // We assume: [0]=Date, [1]=First, [2]=Last, [3]=DOB, [4...]=Provider
        // This is a heuristic for single-space separated data
        const dateRegex = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
        if (dateRegex.test(singleSpaceParts[0]) && dateRegex.test(singleSpaceParts[3])) {
          parts = [
            singleSpaceParts[0],
            singleSpaceParts[1],
            singleSpaceParts[2],
            singleSpaceParts[3],
            singleSpaceParts.slice(4).join(' ')
          ];
        }
      }
    }

    if (parts.length >= 5) {
      records.push({
        examDate: parts[0].trim(),
        patientFirst: parts[1].trim(),
        patientLast: parts[2].trim(),
        dob: parts[3].trim(),
        provider: parts[4].trim()
      });
    }
  }
  return records;
};
