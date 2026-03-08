const fs = require("fs");
const path = require("path");

const RAW_JSON_PATH = path.join(__dirname, "..", "..", "asset", "castello_chatbot_knowledge_v4.json");

function toEndFromStart(start, duration) {
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + duration;
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function normalizeTag(tag) {
  const t = String(tag || "").toLowerCase();
  if (t.includes("principesse")) return "principesse";
  if (t.includes("maghi") || t.includes("magia")) return "maghi";
  if (t.includes("benessere") || t.includes("adulti")) return "benessere";
  if (t.includes("kpop") || t.includes("huntrix")) return "huntrix";
  if (t.includes("natura")) return "natura";
  if (t.includes("passeggiata")) return "passeggiate";
  if (t.includes("pic")) return "pic-nic";
  return t;
}

function normalizeAreaId(id) {
  const map = {
    kpop_show: "kpop",
    bee_dance: "bee_dance",
    princess_garden: "principesse",
    magic_school: "scuola_magia",
    secret_room: "stanza_segreti_mago",
    castle_ball: "ballo_castello",
    snoezelen: "snoezelen",
    merlin_house: "mago_merlino",
    yin_yoga: "yin_yoga",
    heart_meditation: "meditazione_cuore",
    signature_path: "sentiero_incantato",
  };
  return map[id] || id;
}

function mapAreaToActivity(area) {
  const openRanges = [];
  const starts = [];

  if (Array.isArray(area.open_windows)) {
    area.open_windows.forEach((w) => openRanges.push([w.start, w.end]));
  }
  if (Array.isArray(area.sessions)) {
    area.sessions.forEach((s) => {
      starts.push(s.start);
      const end = s.end || toEndFromStart(s.start, s.duration_min || 30);
      openRanges.push([s.start, end]);
    });
  }

  const groupedSpecials = {};
  (area.specials || []).forEach((sp) => {
    const key = sp.name;
    if (!groupedSpecials[key]) {
      groupedSpecials[key] = {
        id: key.toLowerCase().replace(/[^a-z0-9]+/gi, "_"),
        name: sp.name,
        starts: [],
        durationMins: sp.duration_min || 20,
      };
    }
    groupedSpecials[key].starts.push(sp.start);
  });

  return {
    id: normalizeAreaId(area.id),
    name: area.name.replace("Stanza dei Segreti del Mago", "Stanza dei segreti del Mago"),
    location: area.location.replace("–", "-"),
    openRanges,
    starts,
    interests: (area.rules_tags || area.tags || []).map(normalizeTag).filter(Boolean),
    note: (area.notes || []).join(" "),
    childFriendly: !(area.audience || []).includes("adulti"),
    adultsOnly: (area.rules_tags || []).includes("adulti"),
    maxAge: area.id === "snoezelen" ? 7 : undefined,
    subActivities: Object.values(groupedSpecials),
  };
}

function mapRecommendationRules(rules) {
  const alwaysInclude = (rules.always_include || []).map((r) => ({
    ...r,
    include: (r.include || []).map(normalizeAreaId),
  }));
  const preferenceRequirements = (rules.preference_requirements || []).map((r) => ({
    ...r,
    must_include: (r.must_include || []).map(normalizeAreaId),
  }));
  return {
    always_include: alwaysInclude,
    preference_requirements: preferenceRequirements,
    time_constraints: rules.time_constraints || [],
  };
}

function loadFromKnowledgeJson() {
  const raw = fs.readFileSync(RAW_JSON_PATH, "utf8");
  const json = JSON.parse(raw);

  const activities = (json.areas || []).map(mapAreaToActivity);
  activities.push({
    id: "sentiero_incantato",
    name: json.event.signature_path.title,
    location: "Parco",
    openRanges: (json.event.signature_path.opening || []).map((o) => [o.start, o.end]),
    starts: [],
    interests: (json.event.signature_path.tags || []).map(normalizeTag),
    note: json.event.signature_path.description,
    childFriendly: true,
  });

  return {
    eventName: json.event.event_name,
    gates: {
      ticketingOpen: json.event.opening.entry_and_ticket_office.start,
      lastEntry: json.event.opening.entry_and_ticket_office.end,
      activitiesEnd: json.event.opening.activities_end,
      parkClose: json.event.opening.park_castle_close,
    },
    activities,
    recommendationRules: mapRecommendationRules(json.recommendation_rules || {}),
    plannerSpec: json.planner_spec || {},
    faq: json.faq_ready || [],
  };
}

let programData;
try {
  programData = loadFromKnowledgeJson();
} catch (err) {
  programData = {
    eventName: "Orari Castello delle Sorprese 2026",
    gates: { ticketingOpen: "09:30", lastEntry: "15:00", activitiesEnd: "17:00", parkClose: "17:30" },
    activities: [],
    recommendationRules: {},
    plannerSpec: {},
    faq: [],
  };
}

module.exports = { programData };
