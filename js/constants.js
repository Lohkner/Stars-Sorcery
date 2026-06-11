/* ══════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════ */
/** Stat keys in canonical order */
const STATS = ['FUE','DES','CON','INT','SAB','CAR'];

/** Proficiency bonus thresholds by level */
const PROF_THRESHOLDS = [[9,4],[5,3],[1,2]]; // S&S: Nv1-4→+2, Nv5-8→+3, Nv9-10→+4 (PB solo en Salvaciones elegidas y ataques; NO en tiradas de habilidad)

/** XP required to reach each level (index = current level) */
const XP_TABLE = [0, 300, 900, 2100, 4500, 9000, 16000, 28000, 44000, 62000];

/** Inventory slots per card cap */
const MAX_PORTRAIT_W = 600;

/** Max JSON import size (bytes) */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/* ── UI Timing constants (ms) ────────────────────────
   Centralising these avoids scattered magic numbers and
   makes animation tuning a single-location change.      */
const TIMING = {
  /** Loader fade-out after init */
  LOADER_DISMISS:    300,
  /** Safety-net loader timeout */
  LOADER_TIMEOUT:   5000,
  /** Toast visible duration */
  TOAST_VISIBLE:    3200,
  /** Toast fade-out duration */
  TOAST_FADE:        240,
  /** Section confirm-button success flash */
  CONFIRM_FLASH:     480,
  /** Skill-limit flash red duration */
  SKILL_FLASH:       340,
  /** Dice overlay close animation */
  DICE_CLOSE:        180,
  /** Resource colour-flash after adjust */
  RES_FLASH:         240,
  /** Save-guard: max wait for confirm dialog */
  SAVE_GUARD:      10000,
  /** Saved-label "fresh" highlight */
  SAVED_FRESH:      3500,
  /** Swipe ghost-click suppression window — shorter = less dead zone after swipe */
  SWIPE_SUPPRESS:    220,
  /** Swipe snap transition */
  SWIPE_SNAP:        240,
  /** Crop spring transition */
  CROP_SPRING:       280,
  /** Long-press initial threshold — shorter feels more responsive */
  LONGPRESS_HOLD:    320,
  /** Long-press minimum repeat interval */
  LONGPRESS_MIN:      50,
};
