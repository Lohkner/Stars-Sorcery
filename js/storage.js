/* ══════════════════════════════════════════
   STORAGE MODULE
   Versioned persistence with migration support
══════════════════════════════════════════ */
const STORAGE = {
  SCHEMA_VERSION: 2,
  /** Bump when DEFAULT_DB rules data changes so cached rules refresh automatically. */
  RULES_DATA_VERSION: '5.2.2-app-r3',
  KEYS: {
    rules:          'sands_rules',
    rulesVer:       'sands_rules_ver',
    roster:         'sands_roster',
    font:           'ss_font_size',
    scrollPreserve: 'ss_scroll_preserve',
    portSize:       'ss_port_size',
    portShape:      'ss_port_shape',
    version:        'sands_schema_v'
  },

  /** Load rules DB – falls back to DEFAULT_DB. Auto-refreshes when the
      bundled rules data is newer than what's cached, so updated formulas
      reach returning users without touching their saved characters. */
  loadRules() {
    try {
      const storedVer = localStorage.getItem(this.KEYS.rulesVer);
      if (storedVer !== this.RULES_DATA_VERSION) {
        // Stale or absent cache → adopt the bundled rules and stamp the version.
        localStorage.removeItem(this.KEYS.rules);
        localStorage.setItem(this.KEYS.rulesVer, this.RULES_DATA_VERSION);
        return structuredClone(DEFAULT_DB);
      }
      const raw = localStorage.getItem(this.KEYS.rules);
      if (!raw) return structuredClone(DEFAULT_DB);
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : structuredClone(DEFAULT_DB);
    } catch (err) {
      return structuredClone(DEFAULT_DB);
    }
  },

  /** Save rules DB – handles storage quota */
  saveRules(db) {
    try {
      localStorage.setItem(this.KEYS.rules, JSON.stringify(db));
      localStorage.setItem(this.KEYS.rulesVer, this.RULES_DATA_VERSION);
      return true;
    }
    catch (err) { return false; }
  },

  /** Load entire roster */
  loadRoster() {
    try {
      const raw = localStorage.getItem(this.KEYS.roster);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (err) {
      return {};
    }
  },

  /** Save entire roster – returns false on quota error */
  saveRoster(roster) {
    try { localStorage.setItem(this.KEYS.roster, JSON.stringify(roster)); return true; }
    catch (err) { return false; }
  },

  /** Load a single character from roster */
  loadChar(name) {
    const roster = this.loadRoster();
    return roster[String(name)] || null;
  },

  /** Save a single character into roster */
  saveCharData(name, data) {
    const roster = this.loadRoster();
    roster[String(name)] = data;
    return this.saveRoster(roster);
  },

  /** Delete a single character */
  deleteChar(name) {
    const roster = this.loadRoster();
    delete roster[String(name)];
    return this.saveRoster(roster);
  },
};
