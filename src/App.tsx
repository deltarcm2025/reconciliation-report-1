import React, { useState, useMemo } from 'react';
import { 
  Upload, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  XCircle, 
  ChevronDown, 
  ChevronRight, 
  Download,
  ClipboardList,
  RefreshCw,
  Search,
  Filter,
  Users
} from 'lucide-react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { SafeBalanceRecord, OfficeAllyRecord, ReconciledRecord, ReconciliationSummary } from './types';
import { reconcileData, getProviderKey, superNormalize, parseCurrency } from './utils/reconciliation';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [safeBalanceRaw, setSafeBalanceRaw] = useState('');
  const [officeAllyRaw, setOfficeAllyRaw] = useState('');
  const [results, setResults] = useState<{ records: ReconciledRecord[]; summary: ReconciliationSummary } | null>(null);
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTab, setActiveTab] = useState<'input' | 'report'>('input');
  const [reportSubTab, setReportSubTab] = useState<'details' | 'summary' | 'verification' | 'cross-provider'>('details');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [filterType, setFilterType] = useState<'all' | 'both' | 'potential' | 'done_not_billed' | 'billed_not_done'>('all');
  const [selectedMonth, setSelectedMonth] = useState<string>('all');

  // Helper to parse pasted text (tab or comma separated)
  const parsePastedData = (text: string): any[] => {
    if (!text.trim()) return [];
    const result = Papa.parse(text.trim(), {
      header: true,
      skipEmptyLines: true,
      delimiter: text.includes('\t') ? '\t' : undefined,
    });
    return result.data;
  };

  const handleProcess = async () => {
    setIsProcessing(true);
    try {
      const sbData = parsePastedData(safeBalanceRaw).map(row => ({
        examDate: row['Exam Date'] || row['Date'] || '',
        patientFirst: row['Patient First'] || row['First Name'] || '',
        patientLast: row['Patient Last'] || row['Last Name'] || '',
        dob: row['Date of Birth'] || row['DOB'] || '',
        provider: row['Provider'] || '',
      })) as SafeBalanceRecord[];

      const oaData = parsePastedData(officeAllyRaw).map(row => ({
        claimId: row['Claim ID'] || '',
        provider: row['Provider'] || '',
        payer: row['Payer'] || '',
        patientName: row['Patient Name'] || '',
        patientId: row['Patient ID'] || '',
        cpt: row['CPT'] || '',
        units: row['Units'] || '',
        dos: row['DOS'] || '',
        dob: row['DOB'] || row['Date of Birth'] || '',
        charge: row['Charge'] || '',
        paid: row['Paid'] || '',
        status: row['Status'] || '',
      })) as OfficeAllyRecord[];

      const reconciled = reconcileData(sbData, oaData);
      setConfirmedIds(new Set());
      setResults(reconciled);
      setActiveTab('report');
    } catch (error) {
      console.error('Error processing data:', error);
      alert('Error processing data. Please check the format.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'sb' | 'oa') => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const bstr = event.target?.result;
      const workbook = XLSX.read(bstr, { type: 'binary' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const csv = XLSX.utils.sheet_to_csv(worksheet);
      if (type === 'sb') setSafeBalanceRaw(csv);
      else setOfficeAllyRaw(csv);
    };
    reader.readAsBinaryString(file);
  };

  const toggleProvider = (provider: string) => {
    const newExpanded = new Set(expandedProviders);
    if (newExpanded.has(provider)) newExpanded.delete(provider);
    else newExpanded.add(provider);
    setExpandedProviders(newExpanded);
  };

  const availableMonths = useMemo(() => {
    if (!results) return [];
    const months = new Set<string>();
    results.records.forEach(r => {
      const dateStr = r.safeBalance?.examDate || r.officeAlly?.dos;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          const monthYear = d.toLocaleString('default', { month: 'long', year: 'numeric' });
          months.add(monthYear);
        }
      }
    });
    return Array.from(months).sort((a, b) => {
      const dateA = new Date(a);
      const dateB = new Date(b);
      return dateB.getTime() - dateA.getTime();
    });
  }, [results]);

  const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const currencyFormatterCompact = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });

  const handleConfirmMatch = (id: string) => {
    setConfirmedIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const processedRecords = useMemo(() => {
    if (!results) return [];
    return results.records.map(r => ({
      ...r,
      matchConfidence: confirmedIds.has(r.id) ? 'exact' : r.matchConfidence,
      matchReason: confirmedIds.has(r.id) ? `${r.matchReason} (Confirmed)` : r.matchReason,
    })) as ReconciledRecord[];
  }, [results, confirmedIds]);

  const providerMonthlyMatrix = useMemo(() => {
    if (!results) return null;
    const matrix: Record<string, Record<string, { done: number; billed: number; matched: number; collected: number }>> = {};
    const providers = new Set<string>();
    const months = new Set<string>();

    processedRecords.forEach(r => {
      const providerName = r.provider;
      providers.add(providerName);

      const dateStr = r.safeBalance?.examDate || r.officeAlly?.dos;
      if (dateStr) {
        const d = new Date(dateStr);
        const monthYear = d.toLocaleString('default', { month: 'short', year: 'numeric' });
        months.add(monthYear);

        if (!matrix[providerName]) matrix[providerName] = {};
        if (!matrix[providerName][monthYear]) matrix[providerName][monthYear] = { done: 0, billed: 0, matched: 0, collected: 0 };

        if (r.safeBalance) matrix[providerName][monthYear].done++;
        if (r.officeAlly) {
          matrix[providerName][monthYear].billed++;
          matrix[providerName][monthYear].collected += parseCurrency(r.officeAlly.paid);
        }
        if (r.matchType === 'both' && (r.matchConfidence === 'exact' || confirmedIds.has(r.id))) matrix[providerName][monthYear].matched++;
      }
    });

    const sortedMonths = Array.from(months).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    return { matrix, months: sortedMonths, providers: Array.from(providers).sort() };
  }, [results, processedRecords, confirmedIds]);

  const verificationRecords = useMemo(() => {
    if (!results) return { potential: [], missingBill: [], missingExam: [], unitMismatches: [], crossProvider: [] };
    return {
      potential: processedRecords.filter(r => r.matchConfidence === 'partial' && !confirmedIds.has(r.id)),
      missingBill: processedRecords.filter(r => r.matchType === 'done_not_billed'),
      missingExam: processedRecords.filter(r => r.matchType === 'billed_not_done'),
      unitMismatches: processedRecords.filter(r => r.unitInfo?.isMismatch),
      crossProvider: processedRecords.filter(r => r.isCrossProvider && r.matchType === 'both'),
    };
  }, [results, processedRecords, confirmedIds]);

  const filteredRecords = useMemo(() => {
    if (!results) return [];
    return processedRecords.filter(r => {
      const matchesSearch = r.patientName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                           r.provider.toLowerCase().includes(searchQuery.toLowerCase());
      
      let matchesFilter = filterType === 'all';
      if (filterType === 'both') matchesFilter = r.matchType === 'both' && (r.matchConfidence === 'exact' || confirmedIds.has(r.id));
      if (filterType === 'potential') matchesFilter = r.matchType === 'both' && r.matchConfidence === 'partial' && !confirmedIds.has(r.id);
      if (filterType === 'done_not_billed') matchesFilter = r.matchType === 'done_not_billed';
      if (filterType === 'billed_not_done') matchesFilter = r.matchType === 'billed_not_done';

      let matchesMonth = selectedMonth === 'all';
      if (selectedMonth !== 'all') {
        const dateStr = r.safeBalance?.examDate || r.officeAlly?.dos;
        if (dateStr) {
          const d = new Date(dateStr);
          const monthYear = d.toLocaleString('default', { month: 'long', year: 'numeric' });
          matchesMonth = monthYear === selectedMonth;
        } else {
          matchesMonth = false;
        }
      }
      
      return matchesSearch && matchesFilter && matchesMonth;
    });
  }, [results, processedRecords, searchQuery, filterType, selectedMonth, confirmedIds]);

  const monthSummary = useMemo(() => {
    if (!results) return null;
    
    const recs = filteredRecords;
    const summary: ReconciliationSummary = {
      totalDone: recs.filter(r => !!r.safeBalance).length,
      totalBilled: recs.filter(r => !!r.officeAlly).length,
      rawBilledRows: results.summary.rawBilledRows,
      bothCount: recs.filter(r => r.matchType === 'both' && (r.matchConfidence === 'exact' || confirmedIds.has(r.id))).length,
      potentialMatchCount: recs.filter(r => r.matchType === 'both' && r.matchConfidence === 'partial' && !confirmedIds.has(r.id)).length,
      doneNotBilledCount: recs.filter(r => r.matchType === 'done_not_billed').length,
      billedNotDoneCount: recs.filter(r => r.matchType === 'billed_not_done').length,
      totalPaid: recs.filter(r => r.officeAlly?.status.toLowerCase() === 'paid').length,
      totalUnpaid: recs.filter(r => r.officeAlly && r.officeAlly.status.toLowerCase() !== 'paid').length,
      totalCollected: recs.reduce((sum, r) => sum + (r.officeAlly ? parseCurrency(r.officeAlly.paid) : 0), 0),
    };
    return summary;
  }, [filteredRecords, results, confirmedIds]);

  const groupedRecords = useMemo(() => {
    const groups: Record<string, { name: string; records: ReconciledRecord[] }> = {};
    filteredRecords.forEach(r => {
      const key = getProviderKey(r.provider);
      if (!groups[key]) {
        groups[key] = { name: r.provider, records: [] };
      }
      groups[key].records.push(r);
    });
    return groups;
  }, [filteredRecords]);

  const exportToCSV = () => {
    if (!results) return;
    const data = results.records.map(r => ({
      'Patient Name': r.patientName,
      'DOB': r.dob,
      'Provider': r.provider,
      'Match Type': r.matchType.replace(/_/g, ' ').toUpperCase(),
      'Payment Status': r.paymentStatus,
      'Exam Date': r.safeBalance?.examDate || 'N/A',
      'DOS (Billed)': r.officeAlly?.dos || 'N/A',
      'Claim ID': r.officeAlly?.claimId || 'N/A',
      'Payer': r.officeAlly?.payer || 'N/A',
      'Collected': r.officeAlly ? parseCurrency(r.officeAlly.paid) : 0,
    }));
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `reconciliation_report_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const exportToExcel = () => {
    if (!results) return;
    const data = results.records.map(r => ({
      'Patient Name': r.patientName,
      'DOB': r.dob,
      'Provider': r.provider,
      'Match Type': r.matchType.replace(/_/g, ' ').toUpperCase(),
      'Payment Status': r.paymentStatus,
      'Exam Date': r.safeBalance?.examDate || 'N/A',
      'DOS (Billed)': r.officeAlly?.dos || 'N/A',
      'Claim ID': r.officeAlly?.claimId || 'N/A',
      'Payer': r.officeAlly?.payer || 'N/A',
      'Collected': r.officeAlly ? parseCurrency(r.officeAlly.paid) : 0,
    }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Reconciliation');
    XLSX.writeFile(workbook, `reconciliation_report_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const loadSampleData = () => {
    setSafeBalanceRaw(`Exam Date	Patient First	Patient Last	Date of Birth	Provider
11/3/2025	zully	owens	12/1/1962	Diep, DPM, James
11/3/2025	hector	balanzar	4/24/1992	Diep, DPM, James
11/3/2025	eduardo	alvarez	2/14/1980	Diep, DPM, James
11/3/2025	carlos	davila	9/13/1978	Diep, DPM, James
11/3/2025	JONATHAN	BOLF	6/21/1986	Yun, DPM, Lydia
11/3/2025	LELA NICOLE	KEYS	6/10/1975	Yun, DPM, Lydia
11/3/2025	MARIA	TORRES	2/1/1928	Yun, DPM, Lydia
11/3/2025	MARCELO	MORENOZARAGOZA	1/30/1949	Yun, DPM, Lydia
11/4/2025	PHILLIP M	SEMRAU	9/14/1962	Diep, DPM, James
11/4/2025	ANGELINA SUZZANNE	KING	6/6/1976	Diep, DPM, James
11/4/2025	LEON	IRELAND	1/13/1961	Diep, DPM, James
11/4/2025	EDILLA R	ALVAREZ	11/29/1934	Diep, DPM, James
11/4/2025	ALEJANDRO	ORTEGA	7/19/1995	Diep, DPM, James
11/4/2025	CLARENCE J	PATTERSON	8/2/1955	Diep, DPM, James
11/5/2025	RICHARD	VIGLIENZONI	6/11/1953	Diep, DPM, James
11/5/2025	NORSKUSKI	RIVERS	2/6/1972	Benson, DPM, Erica
11/5/2025	ARMANDO	GRIJALVA	2/20/1971	Benson, DPM, Erica
11/5/2025	MARGARITO	LEON	6/10/1932	Benson, DPM, Erica
11/5/2025	TEVITA	VEA	8/28/1963	Benson, DPM, Erica
11/5/2025	Ronald	STAINER	11/16/1946	Benson, DPM, Erica
11/5/2025	DAVID	KILKER	1/27/1963	Benson, DPM, Erica
11/5/2025	CELERINA	MALDONADORIVERA	2/3/1965	Benson, DPM, Erica
11/6/2025	HELEN	SANCHEZ	1/22/1954	Diep, DPM, James
11/6/2025	DOROTHY	LEGOCKI	3/6/1942	Diep, DPM, James
11/6/2025	ANTHONY ALLAN	TAYLOR	10/9/1963	Diep, DPM, James
11/6/2025	KENNETH JUNIOR	WHITE	3/22/1931	Diep, DPM, James
11/7/2025	DAVID	SHURRUM	2/6/1950	Diep, DPM, James
11/7/2025	BEVERLY	BOWMAN	4/28/1930	Diep, DPM, James
11/10/2025	ALFONSO	LOPEZTORRES	2/3/1953	Benson, DPM, Erica
11/10/2025	GARY	SNOW	9/22/1941	Benson, DPM, Erica
11/10/2025	NESTOR F	NAPURIESPARTA	4/2/1962	Benson, DPM, Erica
11/10/2025	JOANN	FISHER	4/3/1954	Benson, DPM, Erica
11/10/2025	SANDRA P	NINO	5/27/1964	Benson, DPM, Erica
11/10/2025	JOANN	ALFANO	7/11/1954	Benson, DPM, Erica
11/11/2025	JUDITH	DOMINGOVICERRA	12/30/1962	Sun, DPM, Xingbo
11/11/2025	OWEN KENNETH	PURDY	3/24/1961	Sun, DPM, Xingbo
11/11/2025	fernando	martinez	5/25/1954	Sun, DPM, Xingbo
11/11/2025	RODNEY	CRUDUP	9/24/1964	Sun, DPM, Xingbo
11/11/2025	OSCAR ALFARO	BAUTISTA	9/9/1951	Sun, DPM, Xingbo
11/11/2025	JOSE	DAVILA	5/1/1966	Sun, DPM, Xingbo
11/11/2025	GIANCARLO	CUCIZ	1/21/1949	Sun, DPM, Xingbo
11/11/2025	MARTIN	PERAZA	5/18/1963	Sun, DPM, Xingbo
11/11/2025	BRENDA J	THOMPSON	3/11/1952	Sun, DPM, Xingbo
11/11/2025	gloria	ramirez	10/20/1969	Sun, DPM, Xingbo
11/11/2025	JANICE R	ADAMS	2/27/1950	Sun, DPM, Xingbo
11/11/2025	TERESA	AVALOS	7/5/1944	Sun, DPM, Xingbo
11/11/2025	WILHELMINA	RICHMOND	2/8/1966	Sun, DPM, Xingbo
11/11/2025	LEE E	WILLIAMS	8/21/1960	Sun, DPM, Xingbo
11/11/2025	luis	raymundo	12/16/1957	Sun, DPM, Xingbo
11/11/2025	RICK	HIGHTOWER	12/31/1960	Sun, DPM, Xingbo
11/11/2025	DANIEL	KNIGHT	8/11/1951	Sun, DPM, Xingbo
11/11/2025	FRED	ROSHAN	9/24/1943	Sun, DPM, Xingbo
11/11/2025	gloria	ramirez	10/20/1969	Sun, DPM, Xingbo
11/11/2025	DIANE	KEARNEY	1/31/1952	Diep, DPM, James
11/11/2025	JOHN	TOMASZEWSKI	8/16/1977	Sun, DPM, Xingbo
11/11/2025	FLORENTINO	DELOSSANTOS	10/19/1959	Sun, DPM, Xingbo
11/11/2025	CINDY L	FOLSOM	5/9/1958	Sun, DPM, Xingbo
11/11/2025	HENRY	DEO RIO	1/16/1950	Diep, DPM, James
11/11/2025	RAMON	VIGIL	5/27/1947	Sun, DPM, Xingbo
11/11/2025	BARRY J	MACK	5/5/1962	Sun, DPM, Xingbo
11/11/2025	HUGO A	TUPAC-YUPANQUI	5/3/1939	Sun, DPM, Xingbo
11/11/2025	ALEX	NINO	6/18/1960	Sun, DPM, Xingbo
11/11/2025	SHAWN P	CAMPBELL	7/27/1970	Sun, DPM, Xingbo
11/11/2025	ENER T	MANALAC	1/15/1932	Sun, DPM, Xingbo
11/11/2025	MANUEL	SIDRIAN	11/10/1974	Sun, DPM, Xingbo
11/11/2025	RYAN	CAMARILLO	3/3/1979	Sun, DPM, Xingbo
11/11/2025	FREDDIE	MITCHELL	12/29/1944	Sun, DPM, Xingbo
11/11/2025	JORGE	KISIELEWSKI	3/16/1950	Sun, DPM, Xingbo
11/11/2025	JERRY R	STANLEY	9/1/1965	Sun, DPM, Xingbo
11/11/2025	ANNETTE	CARRANZA	10/7/1980	Sun, DPM, Xingbo
11/11/2025	donna	moses	5/20/1943	Sun, DPM, Xingbo
11/11/2025	RICHARD L	WALKER	8/5/1962	Sun, DPM, Xingbo
11/11/2025	DANIEL N	GARIBALDI	8/30/1959	Sun, DPM, Xingbo
11/11/2025	MARY	ANELLO	9/4/1952	Sun, DPM, Xingbo
11/11/2025	VONNIE	JORDAN	12/7/1946	Sun, DPM, Xingbo
11/11/2025	MELODIE	SANCHEZFELIX	12/18/1955	Sun, DPM, Xingbo
11/11/2025	TORPEKAY	TARAKI	3/21/1964	Diep, DPM, James
11/11/2025	MARY L	HOWARD	8/23/1947	Diep, DPM, James
11/11/2025	JOSEPH	WILSON	12/8/1944	Diep, DPM, James
11/11/2025	SILVIA	BOTELLO	3/30/1974	Diep, DPM, James
11/11/2025	TENHA DECHEIL	BROWN	6/16/1975	Diep, DPM, James
11/12/2025	RICARDO	WAGNER	6/9/1965	Sun, DPM, Xingbo
11/12/2025	DONALD F	BIANUCCI	5/27/1954	Sun, DPM, Xingbo
11/12/2025	JUAN J	RAMIREZ	5/17/1987	Sun, DPM, Xingbo
11/12/2025	ALISA A	BIANUCCI	6/10/1977	Sun, DPM, Xingbo
11/12/2025	SIMEON	ACEVEDO	2/18/1967	Sun, DPM, Xingbo
11/12/2025	SUNDANCE	ERICKSON	2/26/1964	Sun, DPM, Xingbo
11/12/2025	JEFFREY	VERHOEK	11/10/1964	Sun, DPM, Xingbo
11/12/2025	JORGE	RAMIREZHERNANDEZ	8/5/1967	Sun, DPM, Xingbo
11/12/2025	MICHAEL	ROMERO	4/23/1968	Sun, DPM, Xingbo
11/12/2025	KENNY	LE	9/22/1992	Sun, DPM, Xingbo
11/12/2025	MARIA	VALENCIAQUEVEDO	5/7/1932	Sun, DPM, Xingbo
11/12/2025	TRACY E	WALKER	7/16/1978	Sun, DPM, Xingbo
11/12/2025	EDUARDO	GOMEZNARANJO	10/18/1963	Sun, DPM, Xingbo
11/12/2025	RICHARD	COLLINS	8/3/1976	Sun, DPM, Xingbo
11/12/2025	MIGUEL A	ORTIZ	7/14/1957	Sun, DPM, Xingbo
11/12/2025	JOSE DE JESUS	MAGANA AVITIA	5/11/1996	Sun, DPM, Xingbo
11/12/2025	JANINE C	RYDEN	10/22/1961	Sun, DPM, Xingbo
11/12/2025	CLAUDIO	GUZMAN	11/8/1995	Sun, DPM, Xingbo`);
    setOfficeAllyRaw(`Claim ID	Provider	Payer	Patient Name	Patient ID	CPT	Units	DOS	Charge	Paid	Status
10	JAMES DIEP	Medicare - California (North)	Alcalamorales, Jose	147878720	97750	2	11/25/2025	160	55.82	Paid
14	JAMES DIEP	Medicare - California (North)	Allen, Rita	146414686	97750	2	11/25/2025	160	55.82	Paid
16	JAMES DIEP	Medicare - California (North)	SOSA MORALES, SANDRA	153687672	97750	2	11/25/2025	160	55.82	Paid
19	JAMES DIEP	Medicare - California (North)	CLEVELAND, ROBERT	151761636	97750	2	11/25/2025	160	55.82	Paid
23	JAMES DIEP	Medicare - California (North)	BRAZIL, CINDY	152054562	97750	2	11/25/2025	160	55.82	Paid
30	JAMES DIEP	Medicare - California (North)	Brown, Davey	92783472	97750	1	11/25/2025	80	33.04	Paid
48	JAMES DIEP	Blue Cross - California	Goudeau, CHESTER	154251428	97750	2	12/2/2025	160	75	Paid
51	JAMES DIEP	Medicare - California (North)	Kapiniaris, Andreas	148163335	97750	2	12/2/2025	160	0	Unpaid
52	JAMES DIEP	SELF PAY	ERICKSON, SHANNON	155099250	97750	2	12/2/2025	160	0	Unpaid
55	JAMES DIEP	Medicare - California (North)	DE ALA JR, GREGORIO	143740027	97750	2	12/2/2025	160	0	Unpaid
67	JAMES DIEP	Medicare - California (North)	CUEVAS, JOSE	146696449	97750	2	12/4/2025	160	0	Unpaid
71	JAMES DIEP	Medicare - California (North)	Arcillas, Eddie	149649899	97750	2	12/5/2025	160	0	Unpaid
76	JAMES DIEP	Medicare - California (North)	Travalini, Nancy	155148785	97750	2	12/5/2025	160	0	Unpaid
78	JAMES DIEP	Medicare - California (North)	ALVARADO ROGEL, JOSE	140620741	97750	2	12/5/2025	160	0	Unpaid
82	JAMES DIEP	Blue Cross - California	IRWIN, ELIZABETH	154002027	97750	2	12/9/2025	160	75	Paid
85	JAMES DIEP	Medicare - California (North)	HARRIS, LINDA	100118390	97750	2	12/9/2025	160	0	Unpaid
88	JAMES DIEP	Medicare - California (North)	Irwin, Glenn	151228875	97750	2	12/9/2025	160	0	Unpaid
91	JAMES DIEP	Medicare - California (North)	NISSEN, BERYL	117447285	97750	2	12/9/2025	160	0	Unpaid
94	JAMES DIEP	Medicare - California (North)	NISSEN, ROBERT	117447404	97750	2	12/9/2025	160	0	Unpaid
97	JAMES DIEP	Medicare - California (North)	Kuhlmann, Sonja	147758390	97750	1	12/9/2025	80	0	Unpaid
101	JAMES DIEP	Medicare - California (North)	Donohue, Michael	149079910	97750	2	12/9/2025	160	0	Unpaid
106	JAMES DIEP	Medicare - California (North)	GERARDO RODRIGUEZ, ALVARO	143532182	97750	2	12/9/2025	160	0	Unpaid
116	JAMES DIEP	Medicare - California (North)	TILTON, KAZUEKO	155172616	97750	2	12/11/2025	160	55.82	Paid
125	JAMES DIEP	Medicare - California (North)	DOWNEY, MARK	153448056	97750	2	12/12/2025	160	55.82	Paid
128	JAMES DIEP	Medicare - California (North)	Blake, Stanley	147443182	97750	2	12/12/2025	160	70.06	Paid
132	JAMES DIEP	Medicare - California (North)	Vanputten, Peter	149641168	97750	2	12/12/2025	160	55.82	Paid
135	JAMES DIEP	Medicare - California (North)	Vanputten, Connie	151862165	97750	2	12/12/2025	160	55.82	Paid
139	JAMES DIEP	Medicare - California (North)	KUKURUZOVIC, BOSKO	155174625	97750	2	12/12/2025	160	8.3	Paid
144	JAMES DIEP	Medicare - California (North)	Berryessa, Carol	116753112	97750	2	12/12/2025	160	0	Unpaid
157	JAMES DIEP	Medicare - California (North)	WILLIAMS, ROBERT	147881200	97750	2	12/16/2025	160	55.82	Paid
161	JAMES DIEP	Medicare - California (North)	SHROPSHIRE, JUDY	118112478	97750	2	12/16/2025	160	55.82	Paid
168	JAMES DIEP	Medicare - California (North)	Ode, BERTHA	152095639	97750	2	12/17/2025	160	55.82	Paid
175	JAMES DIEP	Medicare - California (North)	Folas, Milton	154252551	97750	2	12/19/2025	160	70.06	Paid
181	JAMES DIEP	Medicare - California (North)	Heidt, William	101996508	97750	2	12/19/2025	160	55.82	Paid
188	JAMES DIEP	Medicare - California (North)	Grebinski, Richard	149912582	97750	2	12/22/2025	160	55.82	Paid
196	JAMES DIEP	Medicare - California (North)	STOICICH, THOMAS	154869665	97750	2	12/22/2025	160	70.06	Paid
199	JAMES DIEP	Medicare - California (North)	Larsen, Maria	151822646	97750	2	12/22/2025	160	55.82	Paid
213	JAMES DIEP	Medicare - California (North)	Mana, Nancy	145067502	97750	2	12/30/2025	160	70.06	Paid
219	JAMES DIEP	Medicare - California (North)	INTORF, RICKEY	82472007	97750	2	12/30/2025	160	55.82	Paid
239	JAMES DIEP	Medicare - California (North)	DAVIS, TRICIA	148525906	97750	2	1/8/2026	160	0	Unpaid
242	JAMES DIEP	Medicare - California (North)	Miranda, Alicita	102081518	97750	2	1/8/2026	160	0	Unpaid
258	JAMES DIEP	Medicare - California (North)	HEUER JR, HUBERT	150210326	97750	2	1/9/2026	160	56.49	Paid
267	JAMES DIEP	Medicare - California (North)	GENOVE, AIDA	112763620	97750	2	1/12/2026	160	0	Unpaid
271	JAMES DIEP	Medicare - California (North)	HUNTER, DAVE	155489748	97750	2	1/12/2026	160	56.49	Paid
274	JAMES DIEP	Blue Cross - California	Disick, Evan	143532999	97750	2	1/12/2026	160	25	Paid
278	JAMES DIEP	ANTHEM BLUE CROSS PPO	GUADIANA, CARLOS	151394261	97750	2	1/13/2026	160	45.47	Paid
284	JAMES DIEP	Medicare - California (North)	SALAZAR, MARIA	80501674	97750	2	1/13/2026	160	10.78	Paid
300	JAMES DIEP	Medicare - California (North)	Bowman, Dean	151434387	97750	2	1/15/2026	160	56.49	Paid
303	JAMES DIEP	Medicare - California (North)	Jones, Jarrett	97951403	97750	2	1/15/2026	160	56.49	Paid
322	JAMES DIEP	BLUE SHIELD	Kearney, Diane	150987778	97750	2	1/20/2026	160	74.23	Paid
328	JAMES DIEP	Medicare - California (North)	DEL RIO, HENRY	152269777	97750	2	1/20/2026	160	0	Unpaid
331	JAMES DIEP	Medicare - California (North)	WALKER, MARGO	155767212	97750	2	1/20/2026	160	56.49	Paid
339	JAMES DIEP	Medicare - California (North)	Melena, CARIDAD	152271212	97750	2	1/20/2026	160	0	Unpaid
342	JAMES DIEP	Medicare - California (North)	Carreno, Elena	82940679	97750	2	1/20/2026	160	56.49	Paid
346	JAMES DIEP	Medicare - California (North)	LIRA CAMPOS, ROSALIO	155768126	97750	2	1/20/2026	160	56.49	Paid
363	JAMES DIEP	Medicare - California (North)	COLON, SHIRLEY	139134680	97750	2	1/23/2026	160	56.49	Paid
366	JAMES DIEP	Medicare - California (North)	GARCIA, GONZALO	144036707	97750	2	1/23/2026	160	70.91	Paid
373	JAMES DIEP	Medicare - California (North)	Farrukh, Qadeer	155827697	97750	2	1/26/2026	160	56.49	Paid
382	JAMES DIEP	Blue Cross - California	EUGENIO, RICARDO	115606741	97750	2	1/27/2026	160	0	Unpaid
388	JAMES DIEP	Medicare - California (North)	Kapiniaris, Andreas	148163335	97750	2	12/2/2025	160	55.82	Paid
394	JAMES DIEP	Medicare - California (North)	Kuhlmann, Sonja	147758390	97750	2	12/9/2025	160	55.82	Paid
413	JAMES DIEP	Medicare - California (North)	SOSA MORALES, SANDRA	153687672	97750	2	2/3/2026	160	56.49	Paid
437	JAMES DIEP	Medicare - California (North)	GECALE, MARIATERESA	153079331	97750	2	12/23/2025	160	0	Unpaid
440	JAMES DIEP	Medicare - California (North)	ROJAS, RAUL	149912492	97750	2	12/23/2025	160	55.82	Paid
445	JAMES DIEP	Medicare - California (North)	MARTIN, VANESSA	151863258	97750	2	12/23/2025	160	55.82	Paid
450	JAMES DIEP	Medicare - California (North)	ENCIZO, DEBORAH	156052236	97750	2	12/23/2025	160	55.82	Paid
454	JAMES DIEP	BLUE SHIELD	Wilkins, Laurence	153611427	97750	2	12/23/2025	160	73.57	Paid
463	JAMES DIEP	Medicare - California (North)	LUNT, MARJORIE	154471711	97750	2	1/6/2026	160	0	Unpaid
468	JAMES DIEP	BLUE SHIELD FEP	SILKITIS, RUSSELL	154181558	97750	2	2/4/2026	160	25.42	Paid
479	JAMES DIEP	Medicare - California (North)	Creggett, Bernard	146573382	97750	2	1/6/2026	160	56.49	Paid
491	JAMES DIEP	Medicare - California (North)	DE ALA JR, GREGORIO	143740027	97750	2	12/2/2025	160	0	Unpaid
496	JAMES DIEP	Medicare - California (North)	Arcillas, Eddie	149649899	97750	2	12/5/2025	160	0	Unpaid
498	JAMES DIEP	Medicare - California (North)	Travalini, Nancy	155148785	97750	2	12/5/2025	160	0	Unpaid
500	JAMES DIEP	Medicare - California (North)	ALVARADO ROGEL, JOSE	140620741	97750	2	12/5/2025	160	0	Unpaid
503	JAMES DIEP	Medicare - California (North)	HARRIS, LINDA	100118390	97750	2	12/9/2025	160	0	Unpaid
506	JAMES DIEP	Medicare - California (North)	Irwin, Glenn	151228875	97750	2	12/9/2025	160	0	Unpaid
509	JAMES DIEP	Medicare - California (North)	NISSEN, BERYL	117447285	97750	2	12/9/2025	160	0	Unpaid
512	JAMES DIEP	Medicare - California (North)	NISSEN, ROBERT	117447404	97750	2	12/9/2025	160	0	Unpaid
515	JAMES DIEP	Medicare - California (North)	Donohue, Michael	149079910	97750	2	12/9/2025	160	0	Unpaid
518	JAMES DIEP	Medicare - California (North)	GERARDO RODRIGUEZ, ALVARO	143532182	97750	2	12/9/2025	160	0	Unpaid
524	JAMES DIEP	Medicare - California (North)	Wasserbauer, Christine	146787430	97750	2	2/6/2026	160	0	Unpaid
533	JAMES DIEP	Medicare - California (North)	Lutrel, Linda	156152455	97750	2	2/9/2026	160	0	Unpaid
536	JAMES DIEP	Medicare - California (North)	GABIN, MARK	154976027	97750	2	2/9/2026	160	0	Unpaid
582	JAMES DIEP	Medicare - California (North)	KING, PHYLLIS	156373360	97750	2	2/20/2026	160	0	Unpaid
589	JAMES DIEP	BLUE SHIELD	Vaughn, Cheryl	155713698	97750	2	2/11/2026	160	0	Unpaid
594	JAMES DIEP	BLUE SHIELD	MARCANO, KIMBERLY	156456550	97750	2	2/11/2026	160	0	Unpaid
639	JAMES DIEP	Blue Cross - California	Patterson, Clarence	147513016	97750	2	2/10/2026	160	0	Unpaid
652	JAMES DIEP	Medicare - California (North)	CRAWFORD, REMI	96366152	97750	2	2/23/2026	160	0	Unpaid
660	SHANE HALL	Medicare - California (North)	MAHARAJ, KISHOR	154925873	97750	2	12/8/2025	160	55.82	Paid
663	SHANE HALL	CCHP PMB 325	Servellon, Lorena	153872245	97750	2	12/8/2025	160	84.28	Paid
669	SHANE HALL	CCHP PMB 325	LUNA, AMY	154926409	97750	2	12/9/2025	160	84.28	Paid
675	SHANE HALL	CCHP PMB 325	Barajas, Consuelo	152883899	97750	2	12/9/2025	160	84.28	Paid
683	SHANE HALL	CCHP PMB 325	Cortez, Catalina	154951124	97750	2	12/10/2025	160	84.28	Paid
686	SHANE HALL	CCHP PMB 325	Agreda, Jairo	153731971	97750	2	12/10/2025	160	84.28	Paid
690	SHANE HALL	CCHP PMB 325	CatalanTeodoro, Antonia	152913017	97750	2	12/10/2025	160	84.28	Paid
697	SHANE HALL	CCHP PMB 325	VillaSisneros, Pedro	154951393	97750	2	12/10/2025	160	84.28	Paid
701	SHANE HALL	CCHP PMB 325	Carlson, Robert	152912898	97750	2	12/10/2025	160	84.28	Paid
730	SHANE HALL	CCHP PMB 325	Coggburn, Jordan	152549598	97750	2	12/16/2025	160	84.28	Paid
747	SHANE HALL	Medicare - California (North)	CHUN, KEUM	155029490	97750	2	12/16/2025	160	8.3	Paid
755	SHANE HALL	CCHP PMB 325	Lentz, Karen	155029525	97750	2	12/16/2025	160	84.28	Paid
757	SHANE HALL	CCHP PMB 325	Alvizar, Zayra	152873662	97750	2	12/17/2025	160	84.28	Paid
773	SHANE HALL	CCHP PMB 325	CortezDeRamos, Patricia	152883392	97750	2	12/19/2025	160	84.28	Paid`);
  };

  return (
    <div className="min-h-screen bg-[#F5F5F0] text-[#1A1A1A] font-sans pb-20">
      {/* Header */}
      <header className="bg-white border-b border-[#1A1A1A]/10 px-6 py-4 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#5A5A40] rounded-xl flex items-center justify-center text-white">
              <ClipboardList size={24} />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Billing Reconciliation</h1>
              <p className="text-xs text-[#1A1A1A]/50 uppercase tracking-widest font-medium">Safe Balance vs Office Ally</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={() => setActiveTab('input')}
              className={cn(
                "px-4 py-2 rounded-full text-sm font-medium transition-all",
                activeTab === 'input' ? "bg-[#5A5A40] text-white" : "hover:bg-black/5"
              )}
            >
              Data Input
            </button>
            <button 
              onClick={() => results && setActiveTab('report')}
              disabled={!results}
              className={cn(
                "px-4 py-2 rounded-full text-sm font-medium transition-all disabled:opacity-30",
                activeTab === 'report' ? "bg-[#5A5A40] text-white" : "hover:bg-black/5"
              )}
            >
              View Report
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <AnimatePresence mode="wait">
          {activeTab === 'input' ? (
            <motion.div 
              key="input"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="flex justify-between items-end">
                <div>
                  <h2 className="text-3xl font-serif italic text-[#5A5A40]">Import Records</h2>
                  <p className="text-[#1A1A1A]/60 mt-1">Paste your data or upload CSV/Excel files to begin reconciliation.</p>
                </div>
                <button 
                  onClick={loadSampleData}
                  className="text-xs font-semibold uppercase tracking-wider text-[#5A5A40] hover:underline"
                >
                  Load Sample Data
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Safe Balance Input */}
                <div className="bg-white rounded-3xl p-6 shadow-sm border border-black/5 space-y-4">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="text-emerald-600" size={20} />
                      <h3 className="font-semibold">Safe Balance (Exams Done)</h3>
                    </div>
                    <label className="cursor-pointer bg-black/5 hover:bg-black/10 p-2 rounded-xl transition-colors">
                      <Upload size={18} />
                      <input type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={(e) => handleFileUpload(e, 'sb')} />
                    </label>
                  </div>
                  <textarea 
                    value={safeBalanceRaw}
                    onChange={(e) => setSafeBalanceRaw(e.target.value)}
                    placeholder="Paste Safe Balance data here..."
                    className="w-full h-64 bg-[#F5F5F0]/50 rounded-2xl p-4 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/20 border border-transparent focus:border-[#5A5A40]/30 resize-none"
                  />
                </div>

                {/* Office Ally Input */}
                <div className="bg-white rounded-3xl p-6 shadow-sm border border-black/5 space-y-4">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <FileText className="text-blue-600" size={20} />
                      <h3 className="font-semibold">Office Ally (Billed Services)</h3>
                    </div>
                    <label className="cursor-pointer bg-black/5 hover:bg-black/10 p-2 rounded-xl transition-colors">
                      <Upload size={18} />
                      <input type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={(e) => handleFileUpload(e, 'oa')} />
                    </label>
                  </div>
                  <textarea 
                    value={officeAllyRaw}
                    onChange={(e) => setOfficeAllyRaw(e.target.value)}
                    placeholder="Paste Office Ally data here..."
                    className="w-full h-64 bg-[#F5F5F0]/50 rounded-2xl p-4 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/20 border border-transparent focus:border-[#5A5A40]/30 resize-none"
                  />
                </div>
              </div>

              <div className="flex justify-center pt-4">
                <button 
                  onClick={handleProcess}
                  disabled={isProcessing || !safeBalanceRaw || !officeAllyRaw}
                  className="bg-[#5A5A40] text-white px-12 py-4 rounded-full font-semibold text-lg shadow-lg shadow-[#5A5A40]/20 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100 flex items-center gap-3"
                >
                  {isProcessing ? <RefreshCw className="animate-spin" /> : <RefreshCw />}
                  Reconcile Data
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="report"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              {/* Report Sub-Tabs */}
              <div className="flex border-b border-black/5 mb-6">
                <button 
                  onClick={() => setReportSubTab('details')}
                  className={cn(
                    "px-6 py-3 text-sm font-bold uppercase tracking-widest transition-all border-b-2",
                    reportSubTab === 'details' ? "border-[#5A5A40] text-[#5A5A40]" : "border-transparent text-black/40 hover:text-black/60"
                  )}
                >
                  Detailed Report
                </button>
                <button 
                  onClick={() => setReportSubTab('summary')}
                  className={cn(
                    "px-6 py-3 text-sm font-bold uppercase tracking-widest transition-all border-b-2",
                    reportSubTab === 'summary' ? "border-[#5A5A40] text-[#5A5A40]" : "border-transparent text-black/40 hover:text-black/60"
                  )}
                >
                  Provider Summary
                </button>
                <button 
                  onClick={() => setReportSubTab('verification')}
                  className={cn(
                    "px-6 py-3 text-sm font-bold uppercase tracking-widest transition-all border-b-2",
                    reportSubTab === 'verification' ? "border-[#5A5A40] text-[#5A5A40]" : "border-transparent text-black/40 hover:text-black/60"
                  )}
                >
                  Manual Verification
                </button>
                <button 
                  onClick={() => setReportSubTab('cross-provider')}
                  className={cn(
                    "px-6 py-3 text-sm font-bold uppercase tracking-widest transition-all border-b-2",
                    reportSubTab === 'cross-provider' ? "border-[#5A5A40] text-[#5A5A40]" : "border-transparent text-black/40 hover:text-black/60"
                  )}
                >
                  Cross-Provider
                </button>
              </div>

              {reportSubTab === 'details' && (
                <>
                  {/* Summary Cards */}
              <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-4">
                <h3 className="text-xl font-semibold">
                  {selectedMonth === 'all' ? 'Overall Summary' : `${selectedMonth} Summary`}
                </h3>
                <div className="flex items-center gap-2 bg-white rounded-full px-4 py-2 border border-black/5 shadow-sm">
                  <ClipboardList size={16} className="text-[#5A5A40]" />
                  <span className="text-sm font-medium text-[#1A1A1A]/60">Filter Month:</span>
                  <select 
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(e.target.value)}
                    className="bg-transparent text-sm font-bold focus:outline-none cursor-pointer text-[#5A5A40]"
                  >
                    <option value="all">All Time</option>
                    {availableMonths.map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white p-6 rounded-3xl border border-black/5 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-widest text-[#1A1A1A]/40 mb-1">Total Exams Done</p>
                  <p className="text-4xl font-serif italic text-[#5A5A40]">{monthSummary?.totalDone}</p>
                </div>
                <div className="bg-white p-6 rounded-3xl border border-black/5 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-widest text-[#1A1A1A]/40 mb-1">Total Billed</p>
                  <div className="flex items-baseline gap-2">
                    <p className="text-4xl font-serif italic text-[#5A5A40]">{monthSummary?.totalBilled}</p>
                    <span className="text-xs text-black/40 font-medium">Events</span>
                  </div>
                  {monthSummary?.rawBilledRows && monthSummary.rawBilledRows !== monthSummary.totalBilled && (
                    <div className="mt-2 pt-2 border-t border-black/5 flex flex-col gap-1">
                      <div className="flex justify-between text-[10px] font-bold uppercase tracking-tighter">
                        <span className="text-black/40">Input Rows:</span>
                        <span className="text-black/60">{monthSummary.rawBilledRows}</span>
                      </div>
                      <div className="flex justify-between text-[10px] font-bold uppercase tracking-tighter">
                        <span className="text-black/40">Merged (Duplicates/Units):</span>
                        <span className="text-rose-500">-{monthSummary.rawBilledRows - monthSummary.totalBilled}</span>
                      </div>
                      <p className="text-[9px] text-black/30 italic leading-tight mt-1">
                        * Multiple rows for the same patient/date (e.g. split units) are merged into single billing events.
                      </p>
                    </div>
                  )}
                </div>
                <div className="bg-white p-6 rounded-3xl border border-black/5 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-widest text-[#1A1A1A]/40 mb-1">Paid Claims</p>
                  <p className="text-4xl font-serif italic text-emerald-600">{monthSummary?.totalPaid}</p>
                </div>
                <div className="bg-white p-6 rounded-3xl border border-black/5 shadow-sm">
                  <p className="text-xs font-bold uppercase tracking-widest text-[#1A1A1A]/40 mb-1">Unpaid/Pending</p>
                  <p className="text-4xl font-serif italic text-amber-600">{monthSummary?.totalUnpaid}</p>
                </div>
                <div className="bg-[#5A5A40] p-6 rounded-3xl border border-black/5 shadow-lg shadow-[#5A5A40]/10">
                  <p className="text-xs font-bold uppercase tracking-widest text-white/60 mb-1">Total Collected</p>
                  <p className="text-4xl font-serif italic text-white">
                    {currencyFormatter.format(monthSummary?.totalCollected || 0)}
                  </p>
                </div>
              </div>

              {/* Status Breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                <div className="bg-emerald-50 p-6 rounded-3xl border border-emerald-100">
                  <div className="flex items-center gap-2 mb-4">
                    <CheckCircle2 className="text-emerald-600" />
                    <h4 className="font-bold text-emerald-900">Exact Matches</h4>
                  </div>
                  <p className="text-3xl font-serif italic text-emerald-700">{monthSummary?.bothCount}</p>
                  <p className="text-sm text-emerald-600/70 mt-1">Perfect name & date matches.</p>
                </div>
                <div className="bg-indigo-50 p-6 rounded-3xl border border-indigo-100">
                  <div className="flex items-center gap-2 mb-4">
                    <RefreshCw className="text-indigo-600" />
                    <h4 className="font-bold text-indigo-900">Potential Matches</h4>
                  </div>
                  <p className="text-3xl font-serif italic text-indigo-700">{monthSummary?.potentialMatchCount}</p>
                  <p className="text-sm text-indigo-600/70 mt-1">Partial name matches on same date.</p>
                </div>
                <div className="bg-amber-50 p-6 rounded-3xl border border-amber-100">
                  <div className="flex items-center gap-2 mb-4">
                    <AlertCircle className="text-amber-600" />
                    <h4 className="font-bold text-amber-900">Done but Not Billed</h4>
                  </div>
                  <p className="text-3xl font-serif italic text-amber-700">{monthSummary?.doneNotBilledCount}</p>
                  <p className="text-sm text-amber-600/70 mt-1">Missing billing records.</p>
                </div>
                <div className="bg-rose-50 p-6 rounded-3xl border border-rose-100">
                  <div className="flex items-center gap-2 mb-4">
                    <XCircle className="text-rose-600" />
                    <h4 className="font-bold text-rose-900">Billed but Not Done</h4>
                  </div>
                  <p className="text-3xl font-serif italic text-rose-700">{monthSummary?.billedNotDoneCount}</p>
                  <p className="text-sm text-rose-600/70 mt-1">Missing exam reports.</p>
                </div>
                <div className="bg-emerald-50 p-6 rounded-3xl border border-emerald-100">
                  <div className="flex items-center gap-2 mb-4">
                    <Users className="text-emerald-600" />
                    <h4 className="font-bold text-emerald-900">Cross-Provider</h4>
                  </div>
                  <p className="text-3xl font-serif italic text-emerald-700">{verificationRecords.crossProvider.length}</p>
                  <p className="text-sm text-emerald-600/70 mt-1">Matched across different providers.</p>
                </div>
              </div>

              {/* Detailed Report */}
              <div className="bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-black/5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <h3 className="text-xl font-semibold">Detailed Reconciliation Report</h3>
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-black/30" size={16} />
                      <input 
                        type="text" 
                        placeholder="Search patients..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10 pr-4 py-2 bg-[#F5F5F0] rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-[#5A5A40]/20 w-full md:w-64"
                      />
                    </div>
                    <div className="flex items-center gap-2 bg-[#F5F5F0] rounded-full px-3 py-1">
                      <Filter size={14} className="text-black/30" />
                      <select 
                        value={filterType}
                        onChange={(e) => setFilterType(e.target.value as any)}
                        className="bg-transparent text-sm focus:outline-none cursor-pointer"
                      >
                        <option value="all">All Records</option>
                        <option value="both">Exact Matches</option>
                        <option value="potential">Potential Matches</option>
                        <option value="done_not_billed">Done, Not Billed</option>
                        <option value="billed_not_done">Billed, Not Done</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-black/5">
                  {(Object.entries(groupedRecords) as [string, { name: string; records: ReconciledRecord[] }][]).map(([key, group]) => (
                    <div key={key} className="group">
                      <button 
                        onClick={() => toggleProvider(key)}
                        className="w-full px-6 py-4 flex items-center justify-between hover:bg-[#F5F5F0]/50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          {expandedProviders.has(key) ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                          <span className="font-medium text-lg">{group.name}</span>
                          <span className="bg-black/5 px-2 py-0.5 rounded text-xs font-bold text-black/40">
                            {group.records.length} records
                          </span>
                        </div>
                        <div className="flex gap-4">
                          <span className="text-xs font-bold text-emerald-600">
                            {group.records.filter(r => r.matchType === 'both').length} matched
                          </span>
                          <span className="text-xs font-bold text-amber-600">
                            {group.records.filter(r => r.matchType === 'done_not_billed').length} missing bill
                          </span>
                          {group.records.filter(r => r.unitInfo?.isMismatch).length > 0 && (
                            <span className="text-xs font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-100">
                              {group.records.filter(r => r.unitInfo?.isMismatch).length} unit mismatch
                            </span>
                          )}
                        </div>
                      </button>

                      <AnimatePresence>
                        {expandedProviders.has(key) && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden bg-[#F5F5F0]/30"
                          >
                            {/* Side-by-Side Discrepancy Summary */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6 border-b border-black/5 bg-white/50">
                              <div className="space-y-3">
                                <h4 className="text-xs font-black uppercase tracking-widest text-amber-600 flex items-center gap-2">
                                  <AlertCircle size={14} /> Done but Not Billed
                                </h4>
                                <div className="bg-white rounded-2xl border border-amber-100 overflow-hidden">
                                  <table className="w-full text-[11px]">
                                    <thead className="bg-amber-50 text-amber-900/40 uppercase font-bold">
                                      <tr>
                                        <th className="px-3 py-2 text-left">Patient</th>
                                        <th className="px-3 py-2 text-left">Date</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-amber-50">
                                      {group.records.filter(r => r.matchType === 'done_not_billed').map((r, i) => (
                                        <tr key={i}>
                                          <td className="px-3 py-2 font-medium">{r.patientName}</td>
                                          <td className="px-3 py-2">{r.safeBalance?.examDate}</td>
                                        </tr>
                                      ))}
                                      {group.records.filter(r => r.matchType === 'done_not_billed').length === 0 && (
                                        <tr><td colSpan={2} className="px-3 py-4 text-center text-black/20 italic">None</td></tr>
                                      )}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                              <div className="space-y-3">
                                <h4 className="text-xs font-black uppercase tracking-widest text-rose-600 flex items-center gap-2">
                                  <XCircle size={14} /> Billed but Not Done
                                </h4>
                                <div className="bg-white rounded-2xl border border-rose-100 overflow-hidden">
                                  <table className="w-full text-[11px]">
                                    <thead className="bg-rose-50 text-rose-900/40 uppercase font-bold">
                                      <tr>
                                        <th className="px-3 py-2 text-left">Patient</th>
                                        <th className="px-3 py-2 text-left">Date</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-rose-50">
                                      {group.records.filter(r => r.matchType === 'billed_not_done').map((r, i) => (
                                        <tr key={i}>
                                          <td className="px-3 py-2 font-medium">{r.patientName}</td>
                                          <td className="px-3 py-2">{r.officeAlly?.dos}</td>
                                        </tr>
                                      ))}
                                      {group.records.filter(r => r.matchType === 'billed_not_done').length === 0 && (
                                        <tr><td colSpan={2} className="px-3 py-4 text-center text-black/20 italic">None</td></tr>
                                      )}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            </div>

                            <div className="overflow-x-auto">
                              <table className="w-full text-left text-sm">
                                <thead className="bg-black/5 text-black/40 uppercase text-[10px] font-bold tracking-widest">
                                  <tr>
                                    <th className="px-6 py-3">Patient Name</th>
                                    <th className="px-6 py-3">DOB</th>
                                    <th className="px-6 py-3">Date of Service</th>
                                    <th className="px-6 py-3">Status</th>
                                    <th className="px-6 py-3">Payment</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-black/5">
                                  {group.records.map((record, idx) => (
                                    <tr key={idx} className="hover:bg-white transition-colors">
                                      <td className="px-6 py-4">
                                        <div className="flex flex-col">
                                          <span className="font-medium text-[#1A1A1A]">
                                            {record.safeBalance ? `SB: ${record.safeBalance.patientLast}, ${record.safeBalance.patientFirst}` : record.patientName}
                                          </span>
                                          {record.officeAlly && record.safeBalance && 
                                           (superNormalize(record.safeBalance.patientFirst + record.safeBalance.patientLast) !== 
                                            superNormalize(record.officeAlly.patientName)) && (
                                            <span className="text-[10px] text-black/40 font-mono">OA: {record.officeAlly.patientName}</span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-6 py-4">
                                        <div className="flex flex-col">
                                          <span className="text-black/60">{record.dob}</span>
                                          {record.officeAlly?.dob && record.safeBalance?.dob && record.officeAlly.dob !== record.safeBalance.dob && (
                                            <span className="text-[10px] text-rose-500 font-mono">OA: {record.officeAlly.dob}</span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-6 py-4">
                                        <div className="flex flex-col">
                                          <span className="text-black/60">{record.safeBalance?.examDate || record.officeAlly?.dos || 'N/A'}</span>
                                          {record.officeAlly?.dos && record.safeBalance?.examDate && record.officeAlly.dos !== record.safeBalance.examDate && (
                                            <span className="text-[10px] text-amber-600 font-mono">OA: {record.officeAlly.dos}</span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-6 py-4">
                                        <div className="flex flex-col gap-1">
                                          {record.matchType === 'both' ? (
                                            <div className="flex items-center gap-1.5 text-emerald-600 font-medium">
                                              <CheckCircle2 size={14} /> 
                                              <span>{record.matchConfidence === 'exact' ? 'Matched' : 'Partial Match'}</span>
                                            </div>
                                          ) : record.matchType === 'done_not_billed' ? (
                                            <div className="flex items-center gap-1.5 text-amber-600 font-medium">
                                              <AlertCircle size={14} /> Missing Bill
                                            </div>
                                          ) : (
                                            <div className="flex items-center gap-1.5 text-rose-500 font-medium">
                                              <XCircle size={14} /> Missing Exam
                                            </div>
                                          )}
                                          {record.matchReason && (
                                            <span className="text-[9px] leading-tight text-indigo-500 font-bold uppercase max-w-[150px]">{record.matchReason}</span>
                                          )}
                                          {record.unitInfo?.isMismatch && (
                                            <span className="text-[9px] leading-tight text-rose-500 font-bold uppercase bg-rose-50 px-1 py-0.5 rounded border border-rose-100">{record.unitInfo.details}</span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-6 py-4">
                                        <span className={cn(
                                          "px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                                          record.paymentStatus === 'Paid' ? "bg-emerald-100 text-emerald-700" :
                                          record.paymentStatus === 'Unpaid' ? "bg-amber-100 text-amber-700" :
                                          "bg-black/5 text-black/40"
                                        )}>
                                          {record.paymentStatus}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  ))}
                  {Object.keys(groupedRecords).length === 0 && (
                    <div className="p-12 text-center text-black/40">
                      <p>No records found matching your criteria.</p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

            {reportSubTab === 'summary' && providerMonthlyMatrix && (
              <div className="bg-white rounded-3xl border border-black/5 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-black/5 bg-[#F5F5F0]/50">
                  <h3 className="font-bold text-lg">Provider Monthly Overview</h3>
                  <p className="text-sm text-black/40">Summary of exams done vs billed per provider.</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-black/5 text-black/40 uppercase text-[10px] font-bold tracking-widest">
                      <tr>
                        <th className="px-6 py-4 sticky left-0 bg-white z-10">Provider</th>
                        {providerMonthlyMatrix.months.map(m => (
                          <th key={m} className="px-6 py-4 text-center border-l border-black/5">
                            <div className="flex flex-col">
                              <span>{m}</span>
                              <span className="text-[9px] text-emerald-600 font-black">
                                {currencyFormatterCompact.format((Object.values(providerMonthlyMatrix.matrix) as any[]).reduce((sum: number, p) => sum + (p[m]?.collected || 0), 0))}
                              </span>
                            </div>
                          </th>
                        ))}
                        <th className="px-6 py-4 text-center border-l border-black/5 font-black">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-black/5">
                      {providerMonthlyMatrix.providers.map(provider => {
                        let totalDone = 0;
                        let totalBilled = 0;
                        let totalCollected = 0;
                        return (
                          <tr key={provider} className="hover:bg-[#F5F5F0]/30 transition-colors">
                            <td className="px-6 py-4 font-bold sticky left-0 bg-white z-10">{provider}</td>
                            {providerMonthlyMatrix.months.map(month => {
                              const stats = providerMonthlyMatrix.matrix[provider]?.[month] || { done: 0, billed: 0, collected: 0 };
                              totalDone += stats.done;
                              totalBilled += stats.billed;
                              totalCollected += stats.collected;
                              return (
                                <td key={month} className="px-6 py-4 border-l border-black/5">
                                  <div className="flex flex-col items-center">
                                    <div className="flex gap-2 text-[10px] font-bold uppercase tracking-tighter">
                                      <span className="text-emerald-600">Done: {stats.done}</span>
                                      <span className="text-blue-600">Bill: {stats.billed}</span>
                                    </div>
                                    <div className="text-[10px] font-black text-emerald-700 mt-0.5">
                                      {currencyFormatter.format(stats.collected)}
                                    </div>
                                    <div className="w-full h-1 bg-black/5 rounded-full mt-1 overflow-hidden flex">
                                      <div 
                                        className="h-full bg-emerald-500" 
                                        style={{ width: stats.done > 0 ? `${(Math.min(stats.done, stats.billed) / Math.max(stats.done, stats.billed)) * 100}%` : '0%' }} 
                                      />
                                    </div>
                                  </div>
                                </td>
                              );
                            })}
                            <td className="px-6 py-4 border-l border-black/5 bg-black/5">
                              <div className="flex flex-col items-center font-black">
                                <span className="text-emerald-700">D: {totalDone}</span>
                                <span className="text-blue-700">B: {totalBilled}</span>
                                <span className="text-emerald-800 mt-1 text-[11px]">
                                  {currencyFormatterCompact.format(totalCollected)}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {reportSubTab === 'cross-provider' && (
              <div className="space-y-6">
                <div className="bg-white rounded-3xl border border-emerald-100 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-emerald-100 bg-emerald-50/50 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-lg text-emerald-900">Cross-Provider Matches</h3>
                      <p className="text-sm text-emerald-600/70">These patients were matched between Safe Balance and Office Ally, but the recorded provider names differ.</p>
                    </div>
                    <span className="bg-emerald-600 text-white px-3 py-1 rounded-full text-xs font-bold">
                      {verificationRecords.crossProvider.length} Records
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-emerald-50 text-emerald-900/40 uppercase text-[10px] font-bold tracking-widest">
                        <tr>
                          <th className="px-6 py-3">Patient Name</th>
                          <th className="px-6 py-3">DOS</th>
                          <th className="px-6 py-3">Done Under (Safe Balance)</th>
                          <th className="px-6 py-3">Billed Under (Office Ally)</th>
                          <th className="px-6 py-3">Match Confidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-emerald-50">
                        {verificationRecords.crossProvider.map((r, i) => (
                          <tr key={i} className="hover:bg-emerald-50/30">
                            <td className="px-6 py-4 font-medium">{r.patientName}</td>
                            <td className="px-6 py-4">{r.safeBalance?.examDate}</td>
                            <td className="px-6 py-4 text-amber-700 font-bold">{r.safeBalance?.provider}</td>
                            <td className="px-6 py-4 text-emerald-700 font-bold">{r.officeAlly?.provider}</td>
                            <td className="px-6 py-4">
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[10px] font-black uppercase",
                                r.matchConfidence === 'exact' ? "bg-emerald-100 text-emerald-700" : "bg-indigo-100 text-indigo-700"
                              )}>
                                {r.matchConfidence}
                              </span>
                            </td>
                          </tr>
                        ))}
                        {verificationRecords.crossProvider.length === 0 && (
                          <tr><td colSpan={5} className="px-6 py-8 text-center text-black/30 italic">No cross-provider matches found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
            {reportSubTab === 'verification' && (
              <div className="space-y-8">
                {/* Potential Matches Section */}
                <div className="bg-white rounded-3xl border border-indigo-100 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-indigo-100 bg-indigo-50/50 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-lg text-indigo-900">Potential Matches</h3>
                      <p className="text-sm text-indigo-600/70">Partial name matches on the same date. Please verify if these are the same patient.</p>
                    </div>
                    <span className="bg-indigo-600 text-white px-3 py-1 rounded-full text-xs font-bold">
                      {verificationRecords.potential.length} Records
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-indigo-50 text-indigo-900/40 uppercase text-[10px] font-bold tracking-widest">
                        <tr>
                          <th className="px-6 py-3">Safe Balance Data</th>
                          <th className="px-6 py-3">Office Ally Data</th>
                          <th className="px-6 py-3">Match Reason</th>
                          <th className="px-6 py-3">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-indigo-50">
                        {verificationRecords.potential.map((r, i) => (
                          <tr key={i} className="hover:bg-indigo-50/30">
                            <td className="px-6 py-4 border-r border-indigo-100/30">
                              <div className="flex flex-col gap-1">
                                <span className="font-bold text-indigo-900">{r.safeBalance?.patientLast}, {r.safeBalance?.patientFirst}</span>
                                <div className="flex flex-col text-[10px] text-indigo-600/70">
                                  <span>DOB: {r.safeBalance?.dob}</span>
                                  <span>DOS: {r.safeBalance?.examDate}</span>
                                  <span>Prov: {r.safeBalance?.provider}</span>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex flex-col gap-1">
                                <span className="font-bold text-indigo-900">{r.officeAlly?.patientName}</span>
                                <div className="flex flex-col text-[10px] text-indigo-600/70">
                                  <span>DOB: {r.officeAlly?.dob || 'N/A'}</span>
                                  <span>DOS: {r.officeAlly?.dos}</span>
                                  <span>Prov: {r.officeAlly?.provider}</span>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex flex-col gap-1">
                                <span className="text-xs font-bold text-indigo-600 uppercase">{r.matchReason}</span>
                                <div className="flex flex-wrap gap-2">
                                  {r.safeBalance?.dob && r.officeAlly?.dob && r.safeBalance.dob === r.officeAlly.dob && (
                                    <span className="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded text-[9px] font-black">DOB MATCH</span>
                                  )}
                                  {r.safeBalance?.examDate && r.officeAlly?.dos && r.safeBalance.examDate === r.officeAlly.dos && (
                                    <span className="bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded text-[9px] font-black">DOS MATCH</span>
                                  )}
                                  {r.unitInfo?.isMismatch && (
                                    <span className="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded text-[9px] font-black uppercase">{r.unitInfo.details}</span>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <button 
                                onClick={() => handleConfirmMatch(r.id)}
                                className="bg-indigo-600 text-white px-3 py-1 rounded-full text-[10px] font-bold uppercase hover:bg-indigo-700 transition-colors"
                              >
                                Confirm
                              </button>
                            </td>
                          </tr>
                        ))}
                        {verificationRecords.potential.length === 0 && (
                          <tr><td colSpan={4} className="px-6 py-8 text-center text-black/30 italic">No potential matches found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Cross-Provider Matches Section */}
                <div className="bg-white rounded-3xl border border-emerald-100 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-emerald-100 bg-emerald-50/50 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-lg text-emerald-900">Cross-Provider Matches</h3>
                      <p className="text-sm text-emerald-600/70">Exams matched to billing records under a different provider name.</p>
                    </div>
                    <span className="bg-emerald-600 text-white px-3 py-1 rounded-full text-xs font-bold">
                      {verificationRecords.crossProvider.length} Records
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-emerald-50 text-emerald-900/40 uppercase text-[10px] font-bold tracking-widest">
                        <tr>
                          <th className="px-6 py-3">Patient Name</th>
                          <th className="px-6 py-3">DOS</th>
                          <th className="px-6 py-3">Done Under</th>
                          <th className="px-6 py-3">Billed Under</th>
                          <th className="px-6 py-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-emerald-50">
                        {verificationRecords.crossProvider.map((r, i) => (
                          <tr key={i} className="hover:bg-emerald-50/30">
                            <td className="px-6 py-4 font-medium">{r.patientName}</td>
                            <td className="px-6 py-4">{r.safeBalance?.examDate}</td>
                            <td className="px-6 py-4 text-amber-700 font-bold">{r.safeBalance?.provider}</td>
                            <td className="px-6 py-4 text-emerald-700 font-bold">{r.officeAlly?.provider}</td>
                            <td className="px-6 py-4">
                              <span className="bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded text-[10px] font-black uppercase">MATCHED</span>
                            </td>
                          </tr>
                        ))}
                        {verificationRecords.crossProvider.length === 0 && (
                          <tr><td colSpan={5} className="px-6 py-8 text-center text-black/30 italic">No cross-provider matches found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Unit Mismatches Section */}
                <div className="bg-white rounded-3xl border border-rose-100 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-rose-100 bg-rose-50/50 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-lg text-rose-900">Unit Mismatches</h3>
                      <p className="text-sm text-rose-600/70">Billed records with fewer than 2 units (CPT 97750 requires 2 units).</p>
                    </div>
                    <span className="bg-rose-600 text-white px-3 py-1 rounded-full text-xs font-bold">
                      {verificationRecords.unitMismatches.length} Records
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-rose-50 text-rose-900/40 uppercase text-[10px] font-bold tracking-widest">
                        <tr>
                          <th className="px-6 py-3">Patient Name</th>
                          <th className="px-6 py-3">Provider</th>
                          <th className="px-6 py-3">DOS</th>
                          <th className="px-6 py-3">Units Found</th>
                          <th className="px-6 py-3">Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rose-50">
                        {verificationRecords.unitMismatches.map((r, i) => (
                          <tr key={i} className="hover:bg-rose-50/30">
                            <td className="px-6 py-4 font-medium">{r.patientName}</td>
                            <td className="px-6 py-4">{r.provider}</td>
                            <td className="px-6 py-4">{r.officeAlly?.dos || r.safeBalance?.examDate}</td>
                            <td className="px-6 py-4 font-bold text-rose-600">{r.unitInfo?.totalUnits}</td>
                            <td className="px-6 py-4 text-xs italic text-rose-500">{r.unitInfo?.details}</td>
                          </tr>
                        ))}
                        {verificationRecords.unitMismatches.length === 0 && (
                          <tr><td colSpan={5} className="px-6 py-8 text-center text-black/30 italic">No unit mismatches found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Missing Billing Section */}
                <div className="bg-white rounded-3xl border border-amber-100 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-amber-100 bg-amber-50/50 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-lg text-amber-900">Done but Not Billed</h3>
                      <p className="text-sm text-amber-600/70">Exams recorded in Safe Balance that have no matching billing record in Office Ally.</p>
                    </div>
                    <span className="bg-amber-600 text-white px-3 py-1 rounded-full text-xs font-bold">
                      {verificationRecords.missingBill.length} Records
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-amber-50 text-amber-900/40 uppercase text-[10px] font-bold tracking-widest">
                        <tr>
                          <th className="px-6 py-3">Patient Name</th>
                          <th className="px-6 py-3">DOB</th>
                          <th className="px-6 py-3">Provider</th>
                          <th className="px-6 py-3">Exam Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-amber-50">
                        {verificationRecords.missingBill.map((r, i) => (
                          <tr key={i} className="hover:bg-amber-50/30">
                            <td className="px-6 py-4 font-medium">{r.patientName}</td>
                            <td className="px-6 py-4">{r.dob}</td>
                            <td className="px-6 py-4">{r.provider}</td>
                            <td className="px-6 py-4">{r.safeBalance?.examDate}</td>
                          </tr>
                        ))}
                        {verificationRecords.missingBill.length === 0 && (
                          <tr><td colSpan={4} className="px-6 py-8 text-center text-black/30 italic">No missing billing records found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Missing Exam Section */}
                <div className="bg-white rounded-3xl border border-rose-100 shadow-sm overflow-hidden">
                  <div className="px-6 py-4 border-b border-rose-100 bg-rose-50/50 flex justify-between items-center">
                    <div>
                      <h3 className="font-bold text-lg text-rose-900">Billed but Not Done</h3>
                      <p className="text-sm text-rose-600/70">Billing records in Office Ally that have no matching exam report in Safe Balance.</p>
                    </div>
                    <span className="bg-rose-600 text-white px-3 py-1 rounded-full text-xs font-bold">
                      {verificationRecords.missingExam.length} Records
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-rose-50 text-rose-900/40 uppercase text-[10px] font-bold tracking-widest">
                        <tr>
                          <th className="px-6 py-3">Patient Name</th>
                          <th className="px-6 py-3">Provider</th>
                          <th className="px-6 py-3">DOS</th>
                          <th className="px-6 py-3">Claim ID</th>
                          <th className="px-6 py-3">Payer</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-rose-50">
                        {verificationRecords.missingExam.map((r, i) => (
                          <tr key={i} className="hover:bg-rose-50/30">
                            <td className="px-6 py-4 font-medium">{r.patientName}</td>
                            <td className="px-6 py-4">{r.provider}</td>
                            <td className="px-6 py-4">{r.officeAlly?.dos}</td>
                            <td className="px-6 py-4">{r.officeAlly?.claimId}</td>
                            <td className="px-6 py-4">{r.officeAlly?.payer}</td>
                          </tr>
                        ))}
                        {verificationRecords.missingExam.length === 0 && (
                          <tr><td colSpan={5} className="px-6 py-8 text-center text-black/30 italic">No missing exam reports found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

              <div className="flex flex-wrap justify-center gap-4">
                <button 
                  onClick={() => window.print()}
                  className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-[#5A5A40] bg-white border border-[#5A5A40]/20 hover:bg-[#5A5A40]/5 px-6 py-3 rounded-full transition-all shadow-sm"
                >
                  <Download size={16} />
                  PDF Report
                </button>
                <button 
                  onClick={exportToCSV}
                  className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-[#5A5A40] bg-white border border-[#5A5A40]/20 hover:bg-[#5A5A40]/5 px-6 py-3 rounded-full transition-all shadow-sm"
                >
                  <FileText size={16} />
                  CSV Export
                </button>
                <button 
                  onClick={exportToExcel}
                  className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-[#5A5A40] bg-white border border-[#5A5A40]/20 hover:bg-[#5A5A40]/5 px-6 py-3 rounded-full transition-all shadow-sm"
                >
                  <ClipboardList size={16} />
                  Excel Export
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
