export interface Wallet {
  address: string;
  balance: number;
  name: string;
}

export interface Transaction {
  id: string;
  amount: number;
  from: string;
  to: string;
  timestamp: string;
  reference: string;
  fee: number;
  status: 'PENDING' | 'SETTLED' | 'FAILED';
}

export interface Message {
  role: 'researcher' | 'provider';
  content: string;
  paymentId?: string;
}
