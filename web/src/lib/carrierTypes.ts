export interface Carrier {
  id: string;
  name: string;
  notes: string | null;
  tareWeightKg: number;
  // Weighing-station RFID tag (text — leading zeros matter); null = not assigned.
  rfidTag: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
