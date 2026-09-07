// Nickname screening and suggestions.
//
// The goal is to stop what a class will actually try, not to be a comprehensive
// filter. Two rules matter more than the word list itself:
//   1. Disguises are collapsed first, so "sh1t" and "a$$" are caught.
//   2. Innocent words that merely contain a blocked run are removed before
//      matching, so "Cassidy", "classic" and "Scunthorpe" are not refused.
// A word list can never be complete, so the host can still remove anyone from
// the lobby with a click.
import { readFile } from "node:fs/promises";

const BLOCKED = [
  "anal", "anus", "arse", "ass", "bastard", "bitch", "boob", "bollock", "clit",
  "cock", "coon", "cum", "cunt", "dick", "dildo", "douche", "dyke", "fag",
  "fart", "fuck", "gash", "gook", "hitler", "homo", "jizz", "kike", "knob",
  "milf", "nazi", "nigg", "nonce", "paki", "penis", "piss", "poop", "porn",
  "prick", "pube", "pussy", "queef", "queer", "rape", "retard", "scrotum",
  "semen", "sex", "shit", "slut", "smegma", "spastic", "sperm", "spic",
  "tit", "turd", "twat", "vagina", "wank", "whore", "wetback",
];

// Ordinary words and names that contain one of the runs above. Removed before
// matching, longest first, so the innocent word absorbs its own letters.
const INNOCENT = [
  "assassin", "assemble", "assembly", "assess", "asset", "assign", "assist",
  "associate", "assume", "assure", "bass", "brass", "cassidy", "class",
  "classic", "compass", "embassy", "glass", "grass", "harass", "lass", "mass",
  "massive", "pass", "passion", "passport", "potassium", "sassy", "vassal",
  "analog", "analy", "banal", "canal",
  "accumulate", "cucumber", "cumulative", "circumstance", "document", "scum",
  "cockatoo", "cockpit", "cockroach", "cocktail", "cockburn", "hancock",
  "hitchcock", "peacock", "shuttlecock", "woodcock",
  "scunthorpe", "penistone", "clitheroe", "lightwater",
  "essex", "middlesex", "sussex", "wessex", "sextant", "sexton", "sextet",
  "arsenal", "arsenic", "parse", "sparse", "coarse", "hoarse",
  "grape", "drape", "scrape", "therapist", "therapy",
  "titan", "titanic", "title", "competition", "petition", "constitute",
  "attitude", "gratitude", "altitude", "multitude", "practitioner",
  "buttress", "button", "butter", "shiitake", "dickens", "dickinson",
  "homogen", "homograph", "homonym", "homework", "shoe", "hoedown",
  "chestnut", "coconut", "doughnut", "nutmeg", "nutrition", "peanut", "walnut",
  "shitake",
].sort((a, b) => b.length - a.length);

// Letters swapped for digits and symbols, so "sh1t" and "a$$" are caught too.
const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "l" };

let extra = [];

/** Load additional blocked words from a file, one per line. A missing file is fine. */
export async function loadExtraWords(file) {
  try {
    const text = await readFile(file, "utf8");
    extra = text.split("\n").map((l) => l.trim().toLowerCase().replace(/[^a-z]/g, "")).filter(Boolean);
  } catch {
    extra = [];
  }
  return extra.length;
}

/** Collapse the tricks people use to disguise a word: spacing, symbols, leetspeak. */
export function flatten(name) {
  return String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining accents
    .split("")
    .map((c) => LEET[c] ?? c)
    .join("")
    .replace(/[^a-z]/g, "");
}

/** True when a nickname should be refused. */
export function isBlocked(name) {
  let flat = flatten(name);
  if (!flat) return false;
  // let ordinary words claim their own letters before anything is matched
  for (const word of INNOCENT) flat = flat.split(word).join(" ");
  return [...BLOCKED, ...extra].some((w) => w && flat.includes(w));
}

const ADJECTIVES = [
  "Brave", "Bright", "Calm", "Clever", "Cosmic", "Daring", "Eager", "Fearless",
  "Gentle", "Golden", "Happy", "Jolly", "Keen", "Lucky", "Mighty", "Noble",
  "Quick", "Quiet", "Rapid", "Sharp", "Silver", "Steady", "Sunny", "Swift",
  "Wandering", "Wise", "Zesty",
];
const NOUNS = [
  "Otter", "Falcon", "Badger", "Comet", "Dolphin", "Ember", "Fox", "Gecko",
  "Heron", "Ibis", "Jaguar", "Kestrel", "Lynx", "Magpie", "Narwhal", "Osprey",
  "Panther", "Quokka", "Raven", "Seal", "Tiger", "Urchin", "Viper", "Walrus",
  "Yak", "Zebra",
];

/** A friendly random nickname, short enough for the 20 character limit. */
export function suggest() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}${n}`.slice(0, 20);
}
