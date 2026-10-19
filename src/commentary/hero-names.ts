/** Internal hero names whose display name differs from the internal one. */
const ALIASES: Record<string, string> = {
  abyssal_underlord: 'Underlord',
  doom_bringer: 'Doom',
  furion: "Nature's Prophet",
  life_stealer: 'Lifestealer',
  magnataur: 'Magnus',
  necrolyte: 'Necrophos',
  nevermore: 'Shadow Fiend',
  obsidian_destroyer: 'Outworld Destroyer',
  queenofpain: 'Queen of Pain',
  rattletrap: 'Clockwerk',
  shredder: 'Timbersaw',
  skeleton_king: 'Wraith King',
  treant: 'Treant Protector',
  vengefulspirit: 'Vengeful Spirit',
  windrunner: 'Windranger',
  wisp: 'Io',
  zuus: 'Zeus',
  antimage: 'Anti-Mage',
};

/** "npc_dota_hero_shadow_shaman" → "Shadow Shaman". */
export function heroDisplayName(internal: string | null | undefined): string | null {
  if (!internal) return null;
  const key = internal.replace(/^npc_dota_hero_/, '');
  if (!key) return null;
  return ALIASES[key] ?? key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
