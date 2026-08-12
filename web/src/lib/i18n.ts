// Centralized translation for the mobile Home/Stats experience — see the
// feature report for the full audited surface. Deliberately narrow in
// scope: only LabourLink's own fixed interface labels, buttons,
// instructions, validation errors and status text on Home/Stats (plus the
// bottom nav and the message overlay's own Acknowledge control) ever pass
// through here. Administrator-entered content — activity names, custom
// question/answer text, row/carrier names, message bodies, push
// notifications — is never looked up here and must never be. Settings,
// pairing, and desktop administration are out of scope entirely; nothing
// there should ever import this module.
export type Language = "en" | "es";

// The employee's explicit desktop-configured preference
// (employees.preferred_language — 'English' | 'Spanish' | null, see
// 005_employee_profile_fields.sql) is the ONLY input. Never infer from
// nationality, device locale, or anything else. Missing, null, or any value
// other than exactly "Spanish" defaults safely to English — this is the
// single choke point every caller (HomeScreen, StatsScreen, MobileNav,
// PendingMessageOverlay) goes through, so a typo'd/legacy value can never
// silently produce a half-translated screen.
export function resolveLanguage(preferredLanguage: string | null | undefined): Language {
  return preferredLanguage === "Spanish" ? "es" : "en";
}

type Params = Record<string, string | number>;

// A dictionary entry is either a plain string or a template function for
// the handful of keys that interpolate a value — kept as functions (not a
// generic {token} replacer) so each key's own parameter names are checked
// by the compiler instead of matched against a runtime string.
type Entry = string | ((params: Params) => string);

// English is the authoritative key set — every key that exists here must
// also exist in the Spanish dictionary below (checked by
// i18n.test.ts's completeness test), and TRANSLATIONS_EN's own keys are
// what TranslationKey is derived from, so a typo'd key anywhere else in the
// app fails to typecheck rather than silently rendering nothing.
const TRANSLATIONS_EN = {
  // --- Status / connection ---
  loading: "Loading...",
  offlineReconnecting: "Offline — reconnecting…",
  lastConfirmed: (p: Params) => `Last confirmed ${p.date}`,
  statusIdle: "Not working",
  statusWorking: "Working",
  statusOnBreak: "On break",
  online: "Online",
  offline: "Offline",
  pendingSync: (p: Params) => `${p.count} pending sync`,
  switchingToPending: (p: Params) => `Switching to ${p.name} — will sync when back online`,

  // --- Primary actions ---
  chooseJob: "Choose a job",
  current: "Current",
  recentJobs: "Recent jobs",
  noRecentJobs: "No recent jobs yet.",
  autoClosedSuffix: "Auto-closed",
  workedBeforeBreak: (p: Params) => `Worked on ${p.activity} for ${p.duration} before this break`,
  noActivitiesMessage: "No activities have been assigned to you. Please contact your supervisor.",

  // --- Question flow (row/carrier pickers) ---
  stepXOfY: (p: Params) => `Step ${p.step} of ${p.total}`,
  noRowsMessage: "No greenhouse rows configured. Contact your supervisor.",
  searchRowNumber: "Search row number",
  noMatchingRows: "No matching rows",
  noRowsInPhase: "No rows in this phase",
  rowsCount: (p: Params) => `${p.count} rows`,
  noCarriersMessage: "No carriers configured. Contact your supervisor.",
  searchCarrier: "Search carrier",
  noMatchingCarriers: "No matching carriers",
  loadingRows: "Loading rows…",
  loadingCarriers: "Loading carriers…",
  starting: "Starting…",
  confirm: "Confirm",
  skipNoRow: "Skip — No row",
  skipNoCarrier: "Skip — No carrier",
  backDrillDown: "← Back",
  back: "Back",
  cancel: "Cancel",
  close: "Close",

  // --- NFC scan-to-select (row/carrier pickers) — fixed LabourLink prompts
  // only; row/bin names stay whatever the administrator named them. ---
  tapRowTag: "Tap the row's tag to start working there, or choose manually below.",
  tapBinTag: "Tap the bin's tag to start working there, or choose manually below.",
  nfcTagNotRecognized: "That tag isn't registered. Choose manually below.",
  nfcStillWaiting: "Still not seeing a tag — choose manually below.",

  // --- Active-screen row scanning (Home, while working) ---
  readyToScanNextRow: "Ready to scan next row",
  nfcTagIsBinNotRow: "This tag belongs to a bin.",
  nfcOfflineCannotSwitchRow: "Can't switch rows while offline — choose manually below.",

  // --- NFC switch warnings (same-row-recently-completed, minimum-
  // duration) — fixed prompts/buttons only, never the activity/row/bin
  // name itself, which is shown alongside exactly as entered. ---
  sameRowJustFinished: "You just finished this row. Do you want to go back into it?",
  sameBinJustFinished: "You just finished this bin. Do you want to go back into it?",
  goBackIntoRow: "Go back into row",
  goBackIntoBin: "Go back into bin",
  minimumDurationWarningRow: (p: Params) =>
    `You have worked on this row for ${p.elapsedMinutes} minute${p.elapsedMinutes === 1 ? "" : "s"}. The minimum for this activity is ${p.minimumMinutes} minute${p.minimumMinutes === 1 ? "" : "s"}. Make sure you scanned the correct row.`,
  minimumDurationWarningBin: (p: Params) =>
    `You have worked on this bin for ${p.elapsedMinutes} minute${p.elapsedMinutes === 1 ? "" : "s"}. The minimum for this activity is ${p.minimumMinutes} minute${p.minimumMinutes === 1 ? "" : "s"}. Make sure you scanned the correct bin.`,
  startNewRowAnyway: "Start new row anyway",
  startNewBinAnyway: "Start new bin anyway",

  // --- End work / breaks ---
  finishWorkQuestion: "Finish work?",
  finishWorkConfirmMessage:
    "Are you sure you want to finish work for today? This will end your current job and clock you out.",
  finishing: "Finishing…",
  finishWork: "Finish Work",
  keepWorking: "Keep Working",

  // --- Bottom nav (Settings is deliberately absent — never translated) ---
  navHome: "Home",
  navEndWork: "End Work",
  navStartBreak: "Start Break",
  navEndBreak: "End Break",
  navStats: "Stats",

  // --- Stats screen ---
  statsTitle: "Stats",
  statsLoadError: "Could not load stats",
  statsNoData: "No speed data this week",
  statsHoursSuffix: "hrs",
  weekThisWeek: "This Week",
  weekLastWeek: "Last Week",
  weekNWeeksAgo: (p: Params) => `${p.n} Weeks Ago`,

  // --- WorkSessionContext status/error strings surfaced on Home ---
  couldNotLoadStatus: "Could not load status",
  queuedChangesFailed:
    "One or more queued activity changes could not be completed because the activity is no longer available. Your status has been refreshed — please choose again.",
  somethingWentWrong: "Something went wrong",
  mustBeOnlineToFinish: "You must be online to finish work.",
  couldNotReachServer: "Could not reach the server. Please try again.",
  couldNotFinishWork: "Could not finish work. Please try again.",

  // --- The mandatory message overlay's own interface control (see its
  // component comment) — the message body/sender is administrator-entered
  // and never looked up here.
  acknowledge: "Acknowledge",
  acknowledging: "Acknowledging...",
} satisfies Record<string, Entry>;

export type TranslationKey = keyof typeof TRANSLATIONS_EN;

const TRANSLATIONS_ES: Record<TranslationKey, Entry> = {
  loading: "Cargando...",
  offlineReconnecting: "Sin conexión — reconectando…",
  lastConfirmed: (p) => `Última confirmación ${p.date}`,
  statusIdle: "No está trabajando",
  statusWorking: "Trabajando",
  statusOnBreak: "En descanso",
  online: "En línea",
  offline: "Sin conexión",
  pendingSync: (p) => `${p.count} pendiente(s) de sincronizar`,
  switchingToPending: (p) => `Cambiando a ${p.name} — se sincronizará cuando vuelva la conexión`,

  chooseJob: "Elegir un trabajo",
  current: "Actual",
  recentJobs: "Trabajos recientes",
  noRecentJobs: "Aún no hay trabajos recientes.",
  autoClosedSuffix: "Cerrado automáticamente",
  workedBeforeBreak: (p) => `Trabajó en ${p.activity} durante ${p.duration} antes de este descanso`,
  noActivitiesMessage: "No se le han asignado actividades. Comuníquese con su supervisor.",

  stepXOfY: (p) => `Paso ${p.step} de ${p.total}`,
  noRowsMessage: "No hay filas de invernadero configuradas. Comuníquese con su supervisor.",
  searchRowNumber: "Buscar número de fila",
  noMatchingRows: "No hay filas coincidentes",
  noRowsInPhase: "No hay filas en esta fase",
  rowsCount: (p) => `${p.count} filas`,
  noCarriersMessage: "No hay transportadores configurados. Comuníquese con su supervisor.",
  searchCarrier: "Buscar transportador",
  noMatchingCarriers: "No hay transportadores coincidentes",
  loadingRows: "Cargando filas…",
  loadingCarriers: "Cargando transportadores…",
  starting: "Iniciando…",
  confirm: "Confirmar",
  skipNoRow: "Omitir — Sin fila",
  skipNoCarrier: "Omitir — Sin transportador",
  backDrillDown: "← Atrás",
  back: "Atrás",
  cancel: "Cancelar",
  close: "Cerrar",

  tapRowTag: "Toque la etiqueta de la fila para comenzar a trabajar allí, o elija manualmente abajo.",
  tapBinTag: "Toque la etiqueta del transportador para comenzar a trabajar allí, o elija manualmente abajo.",
  nfcTagNotRecognized: "Esa etiqueta no está registrada. Elija manualmente abajo.",
  nfcStillWaiting: "Todavía no se detecta ninguna etiqueta — elija manualmente abajo.",

  readyToScanNextRow: "Listo para escanear la siguiente hilera",
  nfcTagIsBinNotRow: "Esta etiqueta pertenece a un transportador.",
  nfcOfflineCannotSwitchRow: "No se puede cambiar de fila sin conexión — elija manualmente abajo.",

  sameRowJustFinished: "Acaba de terminar esta fila. ¿Desea volver a entrar en ella?",
  sameBinJustFinished: "Acaba de terminar este transportador. ¿Desea volver a entrar en él?",
  goBackIntoRow: "Volver a entrar en la fila",
  goBackIntoBin: "Volver a entrar en el transportador",
  minimumDurationWarningRow: (p: Params) =>
    `Ha trabajado en esta fila durante ${p.elapsedMinutes} minuto${p.elapsedMinutes === 1 ? "" : "s"}. El mínimo para esta actividad es ${p.minimumMinutes} minuto${p.minimumMinutes === 1 ? "" : "s"}. Asegúrese de haber escaneado la fila correcta.`,
  minimumDurationWarningBin: (p: Params) =>
    `Ha trabajado en este transportador durante ${p.elapsedMinutes} minuto${p.elapsedMinutes === 1 ? "" : "s"}. El mínimo para esta actividad es ${p.minimumMinutes} minuto${p.minimumMinutes === 1 ? "" : "s"}. Asegúrese de haber escaneado el transportador correcto.`,
  startNewRowAnyway: "Comenzar nueva fila de todos modos",
  startNewBinAnyway: "Comenzar nuevo transportador de todos modos",

  finishWorkQuestion: "¿Finalizar trabajo?",
  finishWorkConfirmMessage:
    "¿Está seguro de que desea finalizar el trabajo por hoy? Esto terminará su trabajo actual y registrará su salida.",
  finishing: "Finalizando…",
  finishWork: "Finalizar trabajo",
  keepWorking: "Seguir trabajando",

  navHome: "Inicio",
  navEndWork: "Finalizar trabajo",
  navStartBreak: "Iniciar descanso",
  navEndBreak: "Finalizar descanso",
  navStats: "Estadísticas",

  statsTitle: "Estadísticas",
  statsLoadError: "No se pudieron cargar las estadísticas",
  statsNoData: "Sin datos de velocidad esta semana",
  statsHoursSuffix: "h",
  weekThisWeek: "Esta semana",
  weekLastWeek: "Semana pasada",
  weekNWeeksAgo: (p) => `Hace ${p.n} semanas`,

  couldNotLoadStatus: "No se pudo cargar el estado",
  queuedChangesFailed:
    "Uno o más cambios de actividad en cola no se pudieron completar porque la actividad ya no está disponible. Su estado se ha actualizado — por favor, elija de nuevo.",
  somethingWentWrong: "Ocurrió un error",
  mustBeOnlineToFinish: "Debe estar en línea para finalizar el trabajo.",
  couldNotReachServer: "No se pudo conectar con el servidor. Inténtelo de nuevo.",
  couldNotFinishWork: "No se pudo finalizar el trabajo. Inténtelo de nuevo.",

  acknowledge: "Confirmar",
  acknowledging: "Confirmando...",
};

const DICTIONARIES: Record<Language, Record<TranslationKey, Entry>> = {
  en: TRANSLATIONS_EN,
  es: TRANSLATIONS_ES,
};

// The one lookup function every translated component calls. Falls back to
// the English entry if a language's dictionary were ever somehow missing a
// key at runtime (can't happen through normal TypeScript usage — every key
// is required on both dictionaries — but this keeps a corrupted/partial
// dictionary from ever rendering nothing instead of at least English).
export function t(language: Language, key: TranslationKey, params: Params = {}): string {
  const entry = DICTIONARIES[language][key] ?? TRANSLATIONS_EN[key];
  return typeof entry === "function" ? entry(params) : entry;
}

// The small, finite set of server-generated validation-error strings that
// can reach the mobile Home screen's error banner (from
// server/src/routes/mobileTime.ts and server/src/lib/activitySelection.ts —
// both audited directly, not guessed at). These are LabourLink's own
// validation messages, not administrator-entered content, so translating
// them is in scope the same way a client-side error string is. Matched by
// exact English string (the server has no notion of the caller's
// language) — anything not in this table, including a message this table
// simply hasn't been kept in sync with, falls back to the original English
// text rather than showing nothing or throwing, so an unrecognized/future
// server error is always still readable, just not yet localized.
const KNOWN_SERVER_MESSAGES: Record<string, string> = {
  "activityId and a valid idempotencyKey are required": "Se requiere activityId y un idempotencyKey válido",
  "a valid idempotencyKey is required": "Se requiere un idempotencyKey válido",
  "No prior activity to resume": "No hay una actividad anterior para reanudar",
  "A valid activityId is required": "Se requiere un activityId válido",
  "activityId is not available to this employee": "Esta actividad no está disponible para este empleado",
  "One or more answers do not match a configured question for this activity":
    "Una o más respuestas no coinciden con una pregunta configurada para esta actividad",
  "greenhouseRowId is required for this activity": "Se requiere una fila para esta actividad",
  "Invalid or inactive greenhouseRowId": "Fila inválida o inactiva",
  "carrierId is required for this activity": "Se requiere un transportador para esta actividad",
  "Invalid or inactive carrierId": "Transportador inválido o inactivo",
};

export function translateServerMessage(language: Language, message: string): string {
  if (language === "en") return message;
  return KNOWN_SERVER_MESSAGES[message] ?? message;
}
