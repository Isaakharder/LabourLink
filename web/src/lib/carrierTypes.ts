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

// One change to a carrier's RFID tag or tare (GET /api/carriers/:id/history).
export interface CarrierHistoryEntry {
  id: string;
  source: "scale_station" | "carriers_page";
  action: "register" | "move_tag" | "remove_tag" | "page_create" | "page_edit";
  oldRfidTag: string | null;
  newRfidTag: string | null;
  oldTareWeightKg: number | null;
  newTareWeightKg: number | null;
  measuredGrossKg: number | null;
  overwriteConfirmed: boolean | null;
  reason: string | null;
  performedAt: string;
  performedBy: string;
  stationName: string | null;
  movedToName: string | null;
  movedFromName: string | null;
}
