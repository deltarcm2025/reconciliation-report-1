import { SafeBalanceRecord, OfficeAllyRecord, ReconciledRecord, ReconciliationSummary } from '../types';

/**
 * Normalizes a name by trimming, lowercasing, and removing extra spaces.
 */
const normalizeName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Strips all non-alphanumeric characters for aggressive matching.
 */
export const superNormalize = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Normalizes a provider name to a canonical "First Last" format.
 * Handles "Last, DPM, First", "Last, First", "FIRST LAST", and "Last First".
 */
export const normalizeProvider = (name: string) => {
  if (!name) return 'Unknown Provider';
  
  // 1. Remove common medical titles and extra whitespace
  let clean = name.replace(/,?\s*DPM,?\s*/gi, ' ').replace(/,?\s*MD,?\s*/gi, ' ').trim();
  
  // 2. Handle "Last, First" format
  if (clean.includes(',')) {
    const parts = clean.split(',').map(p => p.trim());
    if (parts.length >= 2) {
      clean = `${parts[1]} ${parts[0]}`;
    } else {
      clean = parts[0];
    }
  }

  // 3. Title Case the words
  const words = clean.toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1));
  
  // 4. Canonicalization for grouping (e.g., "Shane Hall" vs "Hall Shane")
  // We'll return the words in a consistent order if we suspect they are reversed.
  // For display, we'll try to keep "First Last" if we can guess it, 
  // but for the purpose of this tool, sorting them alphabetically ensures "Shane Hall" and "Hall Shane" merge.
  // However, sorting might look weird in the UI. 
  // Let's use a "canonical" key for grouping but keep a "pretty" version for display.
  return words.join(' ');
};

/**
 * Returns a canonical key for a provider name to ensure "Shane Hall" and "Hall Shane" are the same.
 */
export const getProviderKey = (name: string) => {
  const normalized = normalizeProvider(name);
  return normalized.toLowerCase().split(/\s+/).sort().join(' ');
};

/**
 * Normalizes a date string to a standard YYYY-MM-DD format if possible.
 */
const normalizeDate = (dateStr: string) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr.trim();
  return d.toISOString().split('T')[0];
};

/**
 * Checks if two dates are within a certain number of days of each other.
 */
const isFuzzyDateMatch = (date1: string, date2: string, maxDays = 2) => {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays <= maxDays;
};

/**
 * Parses a currency string to a number.
 */
export const parseCurrency = (val: string): number => {
  if (!val) return 0;
  return parseFloat(val.replace(/[^0-9.-]+/g, '')) || 0;
};

/**
 * Parses "Last, First" into { first, last }
 */
const parseOfficeAllyName = (fullName: string) => {
  const parts = fullName.split(',').map(p => p.trim());
  if (parts.length >= 2) {
    return { last: parts[0], first: parts[1] };
  }
  return { last: fullName, first: '' };
};

/**
 * Simple Levenshtein distance for spelling similarity.
 */
export const levenshtein = (a: string, b: string): number => {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
};

/**
 * Checks if two names have the same parts regardless of order.
 */
export const namePartsMatch = (nameA: string, nameB: string): boolean => {
  const partsA = superNormalize(nameA).split('').sort().join('');
  const partsB = superNormalize(nameB).split('').sort().join('');
  // This is too aggressive. Let's use word-based set comparison.
  const wordsA = new Set(nameA.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(w => w.length > 1));
  const wordsB = new Set(nameB.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(w => w.length > 1));
  
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  
  let intersection = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) intersection++; });
  
  return intersection >= Math.min(wordsA.size, wordsB.size, 2);
};

export const reconcileData = (
  safeBalance: SafeBalanceRecord[],
  officeAlly: OfficeAllyRecord[]
): { records: ReconciledRecord[]; summary: ReconciliationSummary } => {
  const records: ReconciledRecord[] = [];
  
  // 1. Group Office Ally records to handle unit aggregation
  const oaGroups: Record<string, { records: OfficeAllyRecord[]; totalUnits: number }> = {};
  officeAlly.forEach(oa => {
    const { first, last } = parseOfficeAllyName(oa.patientName);
    const key = `${superNormalize(last)}|${superNormalize(first)}|${normalizeDate(oa.dos)}|${normalizeDate(oa.dob || '')}`;
    if (!oaGroups[key]) {
      oaGroups[key] = { records: [], totalUnits: 0 };
    }
    oaGroups[key].records.push(oa);
    oaGroups[key].totalUnits += parseInt(oa.units) || 0;
  });

  // Track which OA groups have been matched
  const matchedOaGroupKeys = new Set<string>();

  // 2. Iterate through Safe Balance (Exams Done)
  safeBalance.forEach((sb, sbIdx) => {
    const sbLast = normalizeName(sb.patientLast);
    const sbFirst = normalizeName(sb.patientFirst);
    const sbDos = normalizeDate(sb.examDate);
    const sbDob = normalizeDate(sb.dob);
    const sbProvider = normalizeProvider(sb.provider);
    const superSbLast = superNormalize(sb.patientLast);
    const superSbFirst = superNormalize(sb.patientFirst);
    const fullSb = superSbFirst + superSbLast;

    let matchedGroupKey = '';
    let confidence: 'exact' | 'partial' | 'none' = 'none';
    let reason = '';
    let isCrossProvider = false;

    // Helper to find OA group
    const findOaGroup = (predicate: (key: string, group: { records: OfficeAllyRecord[]; totalUnits: number }) => boolean) => {
      return Object.keys(oaGroups).find(key => !matchedOaGroupKeys.has(key) && predicate(key, oaGroups[key]));
    };

    // --- TIER 1: EXACT MATCH (Name + DOS + DOB + Provider) ---
    matchedGroupKey = findOaGroup((key, group) => {
      const oa = group.records[0];
      const { first: oaFirst, last: oaLast } = parseOfficeAllyName(oa.patientName);
      const oaDos = normalizeDate(oa.dos);
      const oaDob = normalizeDate(oa.dob || '');
      const oaProvider = normalizeProvider(oa.provider);
      
      const nameMatch = superNormalize(oaLast) === superSbLast && superNormalize(oaFirst) === superSbFirst;
      const dateMatch = oaDos === sbDos;
      const dobMatch = !sbDob || !oaDob || sbDob === oaDob;
      const providerMatch = oaProvider === sbProvider;
      return nameMatch && dateMatch && dobMatch && providerMatch;
    }) || '';

    if (matchedGroupKey) {
      confidence = 'exact';
      reason = 'Exact match on name, date, and provider';
    } else {
      // --- TIER 2: EXACT MATCH (Name + DOS + DOB) - CROSS PROVIDER ---
      matchedGroupKey = findOaGroup((key, group) => {
        const oa = group.records[0];
        const { first: oaFirst, last: oaLast } = parseOfficeAllyName(oa.patientName);
        const oaDos = normalizeDate(oa.dos);
        const oaDob = normalizeDate(oa.dob || '');
        
        const nameMatch = superNormalize(oaLast) === superSbLast && superNormalize(oaFirst) === superSbFirst;
        const dateMatch = oaDos === sbDos;
        const dobMatch = !sbDob || !oaDob || sbDob === oaDob;
        return nameMatch && dateMatch && dobMatch;
      }) || '';

      if (matchedGroupKey) {
        confidence = 'exact';
        reason = 'Matched on name and date (Cross-Provider)';
        isCrossProvider = true;
      } else {
        // --- TIER 3: PARTIAL - NAME VARIATIONS (Substring, Reordering, Spelling) ---
        matchedGroupKey = findOaGroup((key, group) => {
          const oa = group.records[0];
          const { first: oaFirst, last: oaLast } = parseOfficeAllyName(oa.patientName);
          const oaDos = normalizeDate(oa.dos);
          const oaDob = normalizeDate(oa.dob || '');
          
          const dateMatch = oaDos === sbDos;
          const dobMatch = !sbDob || !oaDob || sbDob === oaDob;
          if (!dateMatch || !dobMatch) return false;

          const sOaLast = superNormalize(oaLast);
          const sOaFirst = superNormalize(oaFirst);
          const sSbLast = superSbLast;
          const sSbFirst = superSbFirst;

          // Substring / Middle Name (e.g., RUSSELL vs RUSSEL JAY)
          const substringMatch = (sOaFirst.includes(sSbFirst) || sSbFirst.includes(sOaFirst)) && 
                                 (sOaLast.includes(sSbLast) || sSbLast.includes(sOaLast));
          
          // Spelling (Levenshtein <= 1)
          const spellingMatch = levenshtein(sOaLast, sSbLast) <= 1 && levenshtein(sOaFirst, sSbFirst) <= 1;
          
          // Reordering (e.g., LIRA CAMPOS vs CAMPOS LIRA)
          const reorderMatch = namePartsMatch(`${oaLast} ${oaFirst}`, `${sb.patientLast} ${sb.patientFirst}`);

          return substringMatch || spellingMatch || reorderMatch;
        }) || '';

        if (matchedGroupKey) {
          confidence = 'partial';
          reason = 'Name variation match (substring/spelling/reorder)';
          const group = oaGroups[matchedGroupKey];
          isCrossProvider = normalizeProvider(group.records[0].provider) !== sbProvider;
        } else {
          // --- TIER 4: PARTIAL - DATE DISCREPANCY ---
          matchedGroupKey = findOaGroup((key, group) => {
            const oa = group.records[0];
            const { first: oaFirst, last: oaLast } = parseOfficeAllyName(oa.patientName);
            const oaDos = normalizeDate(oa.dos);
            const oaDob = normalizeDate(oa.dob || '');

            const nameMatch = superNormalize(oaLast) === superSbLast && superNormalize(oaFirst) === superSbFirst;
            const dobMatch = sbDob && oaDob && sbDob === oaDob;
            const fuzzyDate = isFuzzyDateMatch(sbDos, oaDos, 2);

            return nameMatch && dobMatch && fuzzyDate;
          }) || '';

          if (matchedGroupKey) {
            confidence = 'partial';
            reason = 'Date Similarity (Name/DOB match, DOS differs)';
            const group = oaGroups[matchedGroupKey];
            isCrossProvider = normalizeProvider(group.records[0].provider) !== sbProvider;
          }
        }
      }
    }

    if (matchedGroupKey) {
      const group = oaGroups[matchedGroupKey];
      const oa = group.records[0];
      matchedOaGroupKeys.add(matchedGroupKey);
      
      const unitMismatch = group.totalUnits < 2;
      const unitDetails = group.totalUnits >= 2 
        ? `${group.totalUnits} units (Correct)` 
        : `${group.totalUnits} unit only, no second record found`;

      records.push({
        id: `sb-${sbIdx}`,
        patientName: `${sb.patientLast}, ${sb.patientFirst}`,
        dob: sb.dob,
        provider: sbProvider,
        safeBalance: sb,
        officeAlly: oa,
        matchType: 'both',
        matchConfidence: confidence,
        matchReason: reason,
        isCrossProvider,
        unitInfo: {
          totalUnits: group.totalUnits,
          isMismatch: unitMismatch,
          details: unitDetails
        },
        paymentStatus: (oa.status as any) || 'Pending'
      });
    } else {
      records.push({
        id: `sb-${sbIdx}`,
        patientName: `${sb.patientLast}, ${sb.patientFirst}`,
        dob: sb.dob,
        provider: sbProvider,
        safeBalance: sb,
        matchType: 'done_not_billed',
        matchConfidence: 'none',
        paymentStatus: 'N/A'
      });
    }
  });

  // 3. Add remaining Office Ally records (Billed but not in Safe Balance)
  Object.keys(oaGroups).forEach(key => {
    if (!matchedOaGroupKeys.has(key)) {
      const group = oaGroups[key];
      const oa = group.records[0];
      
      records.push({
        id: `oa-${key}`,
        patientName: oa.patientName,
        dob: oa.dob || 'N/A', 
        provider: normalizeProvider(oa.provider),
        officeAlly: oa,
        matchType: 'billed_not_done',
        matchConfidence: 'none',
        unitInfo: {
          totalUnits: group.totalUnits,
          isMismatch: group.totalUnits < 2,
          details: group.totalUnits < 2 ? `${group.totalUnits} unit only` : `${group.totalUnits} units`
        },
        paymentStatus: (oa.status as any) || 'Pending'
      });
    }
  });

  const summary: ReconciliationSummary = {
    totalDone: safeBalance.length,
    totalBilled: Object.keys(oaGroups).length,
    rawBilledRows: officeAlly.length,
    bothCount: records.filter(r => r.matchType === 'both' && r.matchConfidence === 'exact').length,
    potentialMatchCount: records.filter(r => r.matchType === 'both' && r.matchConfidence === 'partial').length,
    doneNotBilledCount: records.filter(r => r.matchType === 'done_not_billed').length,
    billedNotDoneCount: records.filter(r => r.matchType === 'billed_not_done').length,
    totalPaid: officeAlly.filter(oa => oa.status.toLowerCase() === 'paid').length,
    totalUnpaid: officeAlly.filter(oa => oa.status.toLowerCase() !== 'paid').length,
    totalCollected: officeAlly.reduce((sum, oa) => sum + parseCurrency(oa.paid), 0),
  };

  return { records, summary };
};
