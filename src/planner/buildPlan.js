const { programData } = require("../data/program");
const INTRO_ITALIC_NOTE =
  "Gestisci in autonomia le tue scelte nel corso della giornata in base alle tue esigenze e all'eventuale affollamento di alcune aree.";
const WELLNESS_ADULT_NOTE =
  "Area dedicata a genitori ed adulti. 1 Pass benessere per adulto incluso. Seconda attività benessere solo se disponibili posti liberi ad inizio sessione.";
const FINAL_BOLD_NOTE =
  "Durante la giornata puoi ritirare presso la postazione del fotografo - all'interno del Castello - una copia stampata della tua foto di famiglia in omaggio (servizio offerto dal fotografo)";
const slotUsage = new Map();

function toMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function fmtTime(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function slotKey(activityKey, startText) {
  return `${activityKey}|${startText}`;
}

function getSlotUsage(key) {
  return slotUsage.get(key) || 0;
}

function recordSlotUsage(key) {
  if (!key) return;
  slotUsage.set(key, getSlotUsage(key) + 1);
}

function orderStartsByUsage(activityKey, starts = []) {
  return [...starts].sort((a, b) => {
    const diff = getSlotUsage(slotKey(activityKey, a)) - getSlotUsage(slotKey(activityKey, b));
    if (diff !== 0) return diff;
    return Math.random() - 0.5;
  });
}

function getStayDurationMinutes(stayDuration, availableMins) {
  const bounded = Math.max(0, availableMins);
  if (stayDuration === "over_4h") return bounded;
  if (stayDuration === "between_2_5h_4h") return Math.min(240, bounded);
  return Math.min(150, bounded);
}

function isLongStay(stayDuration, requestedMins) {
  if (stayDuration === "between_2_5h_4h" || stayDuration === "over_4h") return true;
  return requestedMins >= 210;
}

function normalizeInterests(inputInterests = []) {
  const m = {
    principesse: "principesse",
    huntrix: "huntrix",
    maghi: "maghi",
    natura: "natura",
    benessere: "benessere",
    passeggiate: "passeggiate",
    "pic-nic": "pic-nic",
    "punti ristoro": "pic-nic",
    ristorante: "pic-nic",
  };
  return inputInterests.map((i) => m[i.toLowerCase()] || i.toLowerCase());
}

function getActivity(id) {
  return programData.activities.find((a) => a.id === id);
}

function getTimeConstraintDuration(name, fallback) {
  const c = (programData.recommendationRules?.time_constraints || []).find((t) => t.name === name);
  return Number(c?.duration_min || fallback);
}

function evaluateRuleCondition(condition, context) {
  const c = String(condition || "").toLowerCase();
  if (!c || c === "any_user") return true;
  if (c.includes("children_present") && !context.hasChildren) return false;
  if (c.includes("adults_present") && !context.adultsPresent) return false;
  if (c.includes("children_age_max>=7") && !(context.maxChildAge !== null && context.maxChildAge >= 7)) return false;
  if (c.includes("children_age_max<=8") && !(context.maxChildAge !== null && context.maxChildAge <= 8)) return false;
  if (c.includes("children_age_max<=7") && !(context.maxChildAge !== null && context.maxChildAge <= 7)) return false;
  return true;
}

function getAlwaysIncludeSet(context) {
  const set = new Set();
  const rules = programData.recommendationRules?.always_include || [];
  rules.forEach((r) => {
    if (evaluateRuleCondition(r.condition, context)) {
      (r.include || []).forEach((id) => set.add(id));
    }
  });
  return set;
}

function getPreferenceMustIncludeSet(context) {
  const set = new Set();
  const reqs = programData.recommendationRules?.preference_requirements || [];
  reqs.forEach((r) => {
    if (context.interests.includes(String(r.preference || "").toLowerCase())) {
      (r.must_include || []).forEach((id) => set.add(id));
    }
  });
  return set;
}

function scoreActivity(activity, context) {
  let score = 10;
  const interestSet = new Set(context.interests);
  if (activity.interests?.some((i) => interestSet.has(i))) score += 35;
  if (context.hasChildren && activity.childFriendly) score += 12;
  if (!context.hasChildren && activity.adultsOnly) score += 12;
  if (context.minChildAge !== null && activity.maxAge && context.minChildAge > activity.maxAge) score -= 100;
  if (activity.adultsOnly && context.hasChildren) score -= 15;
  return score;
}

function hasOverlap(
  selected,
  start,
  end,
  minGapMins = 0,
  bufferBefore = 0,
  bufferAfter = 0,
  coupledGroup = null
) {
  const candidateStart = start - minGapMins - bufferBefore;
  const candidateEnd = end + minGapMins + bufferAfter;
  return selected.some((s) => {
    if (coupledGroup && s.coupledGroup && s.coupledGroup === coupledGroup) return false;
    const existingStart = s.time - minGapMins - (s.bufferBefore || 0);
    const existingEnd = s.end + minGapMins + (s.bufferAfter || 0);
    return candidateStart < existingEnd && candidateEnd > existingStart;
  });
}

function addBlock(selected, block, minGapMins = 0) {
  if (block.time >= block.end) return false;
  const blockStart = block.time - minGapMins - (block.bufferBefore || 0);
  const blockEnd = block.end + minGapMins + (block.bufferAfter || 0);
  const overlaps = selected.filter((s) => {
    if (block.coupledGroup && s.coupledGroup && block.coupledGroup === s.coupledGroup) return false;
    const existingStart = s.time - minGapMins - (s.bufferBefore || 0);
    const existingEnd = s.end + minGapMins + (s.bufferAfter || 0);
    return blockStart < existingEnd && blockEnd > existingStart;
  });
  if (overlaps.length) {
    const blockPriority = block.priority || 0;
    const canReplace = overlaps.every((o) => (o.priority || 0) < blockPriority);
    if (!canReplace) return false;
    overlaps.forEach((o) => {
      const idx = selected.indexOf(o);
      if (idx >= 0) selected.splice(idx, 1);
    });
  }
  selected.push(block);
  if (block.slotUsageKey) recordSlotUsage(block.slotUsageKey);
  return true;
}

function findFixedStart(
  starts,
  durationMins,
  notBefore,
  selected,
  endLimit = Number.POSITIVE_INFINITY,
  minGapMins = 0,
  bufferBefore = 0,
  bufferAfter = 0,
  activityKey = ""
) {
  const orderedText = activityKey
    ? orderStartsByUsage(activityKey, starts)
    : [...starts].sort((a, b) => toMinutes(a) - toMinutes(b));
  for (const startText of orderedText) {
    const start = toMinutes(startText);
    if (start < notBefore) continue;
    const end = start + durationMins;
    if (end > endLimit) continue;
    if (!hasOverlap(selected, start, end, minGapMins, bufferBefore, bufferAfter)) {
      return {
        time: start,
        end,
        slotUsageKey: activityKey ? slotKey(activityKey, startText) : null,
      };
    }
  }
  return null;
}

function findRangeSlot(
  activity,
  durationMins,
  notBefore,
  selected,
  endLimit = Number.POSITIVE_INFINITY,
  minGapMins = 0,
  bufferBefore = 0,
  bufferAfter = 0,
  activityKey = ""
) {
  const ranges = (activity.openRanges || []).map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) }));

  if (activityKey) {
    const starts = [];
    for (const range of ranges) {
      let candidate = Math.max(range.start, notBefore);
      const cappedEnd = Math.min(range.end, endLimit);
      while (candidate + durationMins <= cappedEnd) {
        starts.push(candidate);
        candidate += 5;
      }
    }
    const orderedStarts = [...starts].sort((a, b) => {
      const usageDiff = getSlotUsage(slotKey(activityKey, fmtTime(a))) - getSlotUsage(slotKey(activityKey, fmtTime(b)));
      if (usageDiff !== 0) return usageDiff;
      return Math.random() - 0.5;
    });
    for (const candidate of orderedStarts) {
      if (
        !hasOverlap(
          selected,
          candidate,
          candidate + durationMins,
          minGapMins,
          bufferBefore,
          bufferAfter
        )
      ) {
        return {
          time: candidate,
          end: candidate + durationMins,
          slotUsageKey: slotKey(activityKey, fmtTime(candidate)),
        };
      }
    }
    return null;
  }

  for (const range of ranges) {
    let candidate = Math.max(range.start, notBefore);
    const cappedEnd = Math.min(range.end, endLimit);
    while (candidate + durationMins <= cappedEnd) {
      if (!hasOverlap(selected, candidate, candidate + durationMins, minGapMins, bufferBefore, bufferAfter)) {
        return { time: candidate, end: candidate + durationMins };
      }
      candidate += 5;
    }
  }
  return null;
}

function scheduleAlwaysSentiero(selected, arrivalMins, endLimit, mandatorySet, minGapMins = 0, startFrom = arrivalMins) {
  if (!mandatorySet.has("sentiero_incantato")) return;
  const sentiero = getActivity("sentiero_incantato");
  const minDuration = getTimeConstraintDuration("sentiero_block", 60);
  const slot = findRangeSlot(sentiero, minDuration, startFrom, selected, endLimit, minGapMins);
  if (!slot) return;
  addBlock(selected, {
    time: slot.time,
    end: slot.end,
    title: sentiero.name,
    location: sentiero.location,
    reason: "Prevedere una durata di circa 1 ora",
      score: 1000,
      priority: 700,
  }, minGapMins);
}

function shouldForceSentiero(context) {
  return !context.hasChildren || context.interests.includes("passeggiate");
}

function scheduleAlwaysShows(selected, arrivalMins, endLimit, minGapMins = 0, options = {}) {
  const {
    includeKpop = true,
    includeBee = true,
    kpopPriority = 1450,
    beePriority = 1440,
    kpopPreferredStart = null,
  } = options;
  const kpop = getActivity("kpop");
  if (includeKpop && kpop?.starts?.length) {
    const kpopStarts = kpopPreferredStart ? kpop.starts.filter((s) => s === kpopPreferredStart) : kpop.starts;
    const slot = findFixedStart(kpopStarts, 40, arrivalMins, selected, endLimit, minGapMins, 15, 15, "kpop");
    if (slot) {
      addBlock(
        selected,
        {
          time: slot.time,
          end: slot.end,
          title: kpop.name,
          location: kpop.location,
          reason: "spettacolo consigliato",
          score: kpopPriority,
          priority: kpopPriority,
          bufferBefore: 15,
          bufferAfter: 15,
          slotUsageKey: slot.slotUsageKey,
        },
        minGapMins
      );
    }
  }

  const bee = getActivity("bee_dance");
  if (includeBee && bee) {
    const slot = findRangeSlot(bee, 30, arrivalMins, selected, endLimit, minGapMins, 15, 15, "bee_dance");
    if (slot) {
      addBlock(
        selected,
        {
          time: slot.time,
          end: slot.end,
          title: bee.name,
          location: bee.location,
          reason: "Animazione di un'ora: puoi arrivare quando vuoi (consigliati 30 minuti).",
          score: beePriority,
          priority: beePriority,
          bufferBefore: 15,
          bufferAfter: 15,
          slotUsageKey: slot.slotUsageKey,
        },
        minGapMins
      );
    }
  }
}

function enforceShowsForStayDuration(selected, arrivalMins, endLimit, minGapMins, stayDuration, kpopPreferredStart = null) {
  const requireKpop = stayDuration === "between_2_5h_4h" || stayDuration === "over_4h";
  const requireBee = stayDuration === "over_4h";
  if (!requireKpop && !requireBee) return;
  const tryForceFixed = (
    activity,
    duration,
    reason,
    priority,
    bufferBefore = 0,
    bufferAfter = 0,
    exactStartText = null
  ) => {
    if (!activity?.starts?.length) return false;
    const starts = (exactStartText ? activity.starts.filter((s) => s === exactStartText) : activity.starts)
      .map(toMinutes)
      .sort((a, b) => a - b);
    for (const start of starts) {
      const end = start + duration;
      if (start < arrivalMins || end > endLimit) continue;
      const added = addBlock(
        selected,
        {
          time: start,
          end,
          title: activity.name,
          location: activity.location,
          reason,
          score: priority,
          priority,
          bufferBefore,
          bufferAfter,
        },
        minGapMins
      );
      if (added) return true;
    }
    return false;
  };

  const tryForceRange = (activity, duration, reason, priority, bufferBefore = 0, bufferAfter = 0) => {
    if (!activity?.openRanges?.length) return false;
    const ranges = activity.openRanges
      .map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) }))
      .sort((a, b) => a.start - b.start);
    for (const range of ranges) {
      let candidate = Math.max(range.start, arrivalMins);
      const cappedEnd = Math.min(range.end, endLimit);
      while (candidate + duration <= cappedEnd) {
        const added = addBlock(
          selected,
          {
            time: candidate,
            end: candidate + duration,
            title: activity.name,
            location: activity.location,
            reason,
            score: priority,
            priority,
            bufferBefore,
            bufferAfter,
          },
          minGapMins
        );
        if (added) return true;
        candidate += 5;
      }
    }
    return false;
  };

  if (requireKpop) {
    tryForceFixed(getActivity("kpop"), 40, "spettacolo consigliato", 2300, 15, 15, kpopPreferredStart);
  }
  if (requireBee) {
    tryForceRange(
      getActivity("bee_dance"),
      30,
      "Animazione di un'ora: puoi arrivare quando vuoi (consigliati 30 minuti).",
      2290,
      15,
      15
    );
  }
}

function scheduleChildrenRules(selected, context, arrivalMins, endLimit, mandatorySet, minGapMins = 0) {
  if (mandatorySet.has("snoezelen")) {
    const snoezelen = getActivity("snoezelen");
    const slot = findFixedStart(snoezelen.starts, 20, arrivalMins, selected, endLimit, minGapMins, 0, 0, "snoezelen");
    if (slot) {
      addBlock(selected, {
        time: slot.time,
        end: slot.end,
        title: snoezelen.name,
        location: snoezelen.location,
        reason: "sessione consigliata per bambini 1-7 anni (durata 20 minuti)",
        score: 1900,
        priority: 1900,
        slotUsageKey: slot.slotUsageKey,
      }, minGapMins);
    }
  }
}

function scheduleAdultsWellness(selected, context, arrivalMins, endLimit, mandatorySet, minGapMins = 0, forceAll = false) {
  if (context.hasChildren) return;
  const targetIds = forceAll
    ? ["yin_yoga", "meditazione_cuore"]
    : ["yin_yoga", "meditazione_cuore"].filter((id) => mandatorySet.has(id));
  if (!targetIds.length) return;
  targetIds.forEach((id) => {
    const a = getActivity(id);
    const slot = findFixedStart(a.starts, 30, arrivalMins, selected, endLimit, minGapMins, 0, 0, id);
    if (slot) {
      addBlock(selected, {
        time: slot.time,
        end: slot.end,
        title: a.name,
        location: a.location,
        reason: WELLNESS_ADULT_NOTE,
        score: forceAll ? 1600 : 950,
        priority: forceAll ? 1600 : 800,
        slotUsageKey: slot.slotUsageKey,
      }, minGapMins);
    }
  });
}

function scheduleAdultsWellnessPriorityFlow(selected, arrivalMins, endLimit) {
  const ordered = ["yin_yoga", "meditazione_cuore"].map(getActivity).filter(Boolean);
  let cursor = arrivalMins;
  ordered.forEach((a) => {
    const slot = findFixedStart(a.starts, 30, cursor, selected, endLimit, 0, 0, 0, a.id);
    if (!slot) return;
    addBlock(
      selected,
      {
        time: slot.time,
        end: slot.end,
        title: a.name,
        location: a.location,
        reason: WELLNESS_ADULT_NOTE,
        score: 1700,
        priority: 1700,
        slotUsageKey: slot.slotUsageKey,
      },
      0
    );
    cursor = slot.end;
  });
}

function schedulePrincessRules(selected, arrivalMins, endLimit, preferenceMustSet, minGapMins = 0) {
  const targetIds = ["principesse", "ballo_castello"].filter((id) => preferenceMustSet.has(id));
  if (!targetIds.length) return;
  const durationById = {
    principesse: 20,
    ballo_castello: 30,
  };

  targetIds.map(getActivity).forEach((a) => {
    if (!a) return;
    const duration = durationById[a.id] || 30;
    const ranges =
      a.id === "ballo_castello"
        ? getBalloCastelloRanges().map(([start, end]) => ({ start, end }))
        : (a.openRanges || []).map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) }));
    for (const range of ranges) {
      let candidate = Math.max(range.start, arrivalMins);
      const maxEnd = Math.min(range.end, endLimit);
      while (candidate + duration <= maxEnd) {
        const added = addBlock(
          selected,
          {
            time: candidate,
            end: candidate + duration,
            title: a.name,
            location: a.location,
            reason: "preferenza principesse",
            score: 1550,
            priority: 1550,
          },
          minGapMins
        );
        if (added) return;
        candidate += 5;
      }
    }
  });
}

function enforceBalloCastelloForPrincess(selected, interests, arrivalMins, endLimit, minGapMins = 0) {
  if (!interests.includes("principesse")) return;
  if (selected.some((s) => /Ballo nel Castello/i.test(s.title))) return;
  const ballo = getActivity("ballo_castello");
  if (!ballo) return;
  const duration = 30;
  const ranges = getBalloCastelloRanges().map(([start, end]) => ({ start, end }));
  for (const range of ranges) {
    let candidate = Math.max(range.start, arrivalMins);
    const capEnd = Math.min(range.end, endLimit);
    while (candidate + duration <= capEnd) {
      const added = addBlock(
        selected,
        {
          time: candidate,
          end: candidate + duration,
          title: ballo.name,
          location: ballo.location,
          reason: "preferenza principesse",
          score: 2600,
          priority: 2600,
        },
        minGapMins
      );
      if (added) return;
      candidate += 5;
    }
  }
}

function scheduleSentieroForMerlino(selected, arrivalMins, endLimit, merlinoTime, minGapMins = 0) {
  const sentiero = getActivity("sentiero_incantato");
  if (!sentiero) return false;
  const duration = 60;
  const ranges = (sentiero.openRanges || [])
    .map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) }))
    .sort((a, b) => a.start - b.start);

  // Preferisci il blocco immediatamente prima di Merlino.
  for (const range of ranges) {
    const latestEnd = Math.min(range.end, merlinoTime);
    let candidateStart = latestEnd - duration;
    if (candidateStart < range.start || candidateStart < arrivalMins) continue;
    while (candidateStart >= Math.max(range.start, arrivalMins)) {
      const candidateEnd = candidateStart + duration;
      if (!hasOverlap(selected, candidateStart, candidateEnd, minGapMins)) {
        return addBlock(
          selected,
          {
            time: candidateStart,
            end: candidateEnd,
            title: sentiero.name,
            location: sentiero.location,
            reason: "abbinata a Mago Merlino: tempo percorso (60 min)",
            score: 1250,
            priority: 1250,
          },
          minGapMins
        );
      }
      candidateStart -= 5;
    }
  }

  // Fallback: metti il sentiero in un'altra finestra utile.
  const fallback = findRangeSlot(sentiero, duration, arrivalMins, selected, endLimit, minGapMins);
  if (!fallback) return false;
  return addBlock(
    selected,
    {
      time: fallback.time,
      end: fallback.end,
      title: sentiero.name,
      location: sentiero.location,
      reason: "abbinata a Mago Merlino: tempo percorso (60 min)",
      score: 1250,
      priority: 1250,
    },
    minGapMins
  );
}

function scheduleCoupledMerlinoSentiero(selected, arrivalMins, endLimit, minGapMins = 0) {
  const merlino = getActivity("mago_merlino");
  const sentiero = getActivity("sentiero_incantato");
  if (!merlino || !sentiero) return false;

  const merlinoRanges = (merlino.openRanges || []).map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) }));
  const sentieroRanges = (sentiero.openRanges || []).map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) }));
  const duration = 60;
  const group = "merlino_sentiero";

  for (const mr of merlinoRanges) {
    for (const sr of sentieroRanges) {
      let candidate = Math.max(mr.start, sr.start, arrivalMins);
      const capEnd = Math.min(mr.end, sr.end, endLimit);
      while (candidate + duration <= capEnd) {
        if (!hasOverlap(selected, candidate, candidate + duration, minGapMins, 0, 0, group)) {
          const merlinoAdded = addBlock(
            selected,
            {
              time: candidate,
              end: candidate + duration,
              title: merlino.name,
              location: merlino.location,
              reason: "preferenza maghi: incontro con Merlino",
              score: 2700,
              priority: 2700,
              coupledGroup: group,
              colorKey: "brown",
              groupKey: "maghi",
            },
            minGapMins
          );
          if (!merlinoAdded) break;
          const sentieroAdded = addBlock(
            selected,
            {
              time: candidate,
              end: candidate + duration,
              title: sentiero.name,
              location: sentiero.location,
              reason: "Prevedere una durata di circa 1 ora",
              score: 2690,
              priority: 2690,
              coupledGroup: group,
              colorKey: "brown",
              groupKey: "maghi",
            },
            minGapMins
          );
          if (!sentieroAdded) {
            const idx = selected.findIndex((s) => s.coupledGroup === group && s.title === merlino.name);
            if (idx >= 0) selected.splice(idx, 1);
            break;
          }
          return true;
        }
        candidate += 5;
      }
    }
  }
  return false;
}

function enforceMerlinoSentieroTogether(selected, arrivalMins, endLimit, minGapMins = 0, forcePair = false) {
  const hasMerlino = selected.some((s) => s.title === "Casa di Mago Merlino");
  const hasSentiero = selected.some((s) => /Sentiero Incantato/i.test(s.title));
  if (!forcePair && !hasMerlino && !hasSentiero) return;
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    if (selected[i].title === "Casa di Mago Merlino" || /Sentiero Incantato/i.test(selected[i].title)) {
      selected.splice(i, 1);
    }
  }
  let paired = scheduleCoupledMerlinoSentiero(selected, arrivalMins, endLimit, minGapMins);
  if (paired || !forcePair) return;

  // Fallback for mandatory pairing: libera attivita di priorita bassa/media e riprova
  // senza toccare la pausa pranzo.
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    if (selected[i].kind === "lunch") continue;
    if ((selected[i].priority || 0) < 2300) selected.splice(i, 1);
  }
  scheduleCoupledMerlinoSentiero(selected, arrivalMins, endLimit, minGapMins);
}

function enforceLongStayMaghiMerlinoSentiero(selected, arrivalMins, endLimit) {
  enforceMerlinoSentieroTogether(selected, arrivalMins, endLimit, 0, true);
}

function scheduleMaghiRules(selected, context, arrivalMins, endLimit, preferenceMustSet, minGapMins = 0, allowMerlino = true) {
  if (!preferenceMustSet.has("scuola_magia") && !preferenceMustSet.has("stanza_segreti_mago") && !preferenceMustSet.has("mago_merlino")) return;
  const scuola = getActivity("scuola_magia");
  const stanza = getActivity("stanza_segreti_mago");
  const merlino = getActivity("mago_merlino");
  if (!scuola || !stanza || !merlino) return;
  const ruleGap = 0;

  // 1) Inserisci sempre la Scuola di Magia (visita area)
  const scuolaAreaSlot = findRangeSlot(scuola, 20, arrivalMins, selected, endLimit, ruleGap);
  if (scuolaAreaSlot) {
    addBlock(
      selected,
      {
        time: scuolaAreaSlot.time,
        end: scuolaAreaSlot.end,
        title: scuola.name,
        location: scuola.location,
        reason: "preferenza maghi: area scuola magia",
        score: 1300,
        priority: 1300,
      },
      ruleGap
    );
  }

  // 2) Lezioni della scuola: preferisci due lezioni diverse in orari diversi.
  const pozioni = (scuola.subActivities || []).find((s) => /pozioni/i.test(s.name));
  const difesa = (scuola.subActivities || []).find((s) => /difesa/i.test(s.name));
  const lessonBlocks = [];
  if (pozioni?.starts?.length) {
    const slot = findFixedStart(
      pozioni.starts,
      pozioni.durationMins || 15,
      arrivalMins,
      selected,
      endLimit,
      ruleGap,
      0,
      0,
      "scuola_magia_pozioni"
    );
    if (slot) {
      lessonBlocks.push({
        time: slot.time,
        end: slot.end,
        title: `${pozioni.name} (${scuola.name})`,
        location: scuola.location,
        reason: "preferenza maghi: lezione",
        score: 1290,
        priority: 1290,
        slotUsageKey: slot.slotUsageKey,
      });
    }
  }
  if (difesa?.starts?.length) {
    const slot = findFixedStart(
      difesa.starts,
      difesa.durationMins || 15,
      arrivalMins,
      selected,
      endLimit,
      ruleGap,
      0,
      0,
      "scuola_magia_difesa"
    );
    if (slot) {
      lessonBlocks.push({
        time: slot.time,
        end: slot.end,
        title: `${difesa.name} (${scuola.name})`,
        location: scuola.location,
        reason: "preferenza maghi: lezione",
        score: 1288,
        priority: 1288,
        slotUsageKey: slot.slotUsageKey,
      });
    }
  }
  lessonBlocks
    .sort((a, b) => a.time - b.time)
    .forEach((lesson) => addBlock(selected, lesson, ruleGap));

  // 3) Inserisci sempre Stanza dei segreti del Mago (visita area)
  const stanzaAreaSlot = findRangeSlot(stanza, 20, arrivalMins, selected, endLimit, ruleGap);
  if (stanzaAreaSlot) {
    addBlock(
      selected,
      {
        time: stanzaAreaSlot.time,
        end: stanzaAreaSlot.end,
        title: stanza.name,
        location: stanza.location,
        reason: "preferenza maghi: area stanza dei segreti",
        score: 1280,
        priority: 1280,
      },
      ruleGap
    );
  }

  // 4) Se possibile aggiungi una sessione di Mini Torneo.
  const miniTorneo = (stanza.subActivities || []).find((s) => /mini torneo/i.test(s.name));
  if (miniTorneo?.starts?.length) {
    const miniSlot = findFixedStart(
      miniTorneo.starts,
      miniTorneo.durationMins || 20,
      arrivalMins,
      selected,
      endLimit,
      ruleGap,
      0,
      0,
      "stanza_segreti_mini_torneo"
    );
    if (miniSlot) {
      addBlock(
        selected,
        {
          time: miniSlot.time,
          end: miniSlot.end,
          title: `${miniTorneo.name} (${stanza.name})`,
          location: stanza.location,
          reason: "preferenza maghi: mini torneo",
          score: 1270,
          priority: 1270,
          slotUsageKey: miniSlot.slotUsageKey,
        },
        ruleGap
      );
    }
  }

  // 5) Casa di Mago Merlino + Sentiero Incantato insieme, stesso inizio e 1 ora.
  if (allowMerlino) {
    scheduleCoupledMerlinoSentiero(selected, arrivalMins, endLimit, ruleGap);
  }
}

function scheduleLunchBreak(
  selected,
  arrivalMins,
  endLimit,
  minGapMins = 0,
  notBefore = arrivalMins,
  fixedLunchRange = null,
  priority = 1430
) {
  const lunchGap = 0;
  const LUNCH_DURATION = 60;
  if (
    fixedLunchRange &&
    Number.isFinite(fixedLunchRange.start) &&
    Number.isFinite(fixedLunchRange.end) &&
    fixedLunchRange.end > fixedLunchRange.start
  ) {
    if (fixedLunchRange.start >= arrivalMins && fixedLunchRange.end <= endLimit) {
      return addBlock(
        selected,
        {
          time: fixedLunchRange.start,
          end: fixedLunchRange.end,
          title: "PAUSA PRANZO CONSIGLIATA",
          location: "Punti ristoro / area picnic",
          reason: `PAUSA PRANZO CONSIGLIATA dalle ${fmtTime(fixedLunchRange.start)} alle ${fmtTime(fixedLunchRange.end)}`,
          score: priority,
          priority,
          kind: "lunch",
        },
        lunchGap
      );
    }
    return false;
  }
  const preferredStarts = [toMinutes("11:30"), toMinutes("13:30")]; // finestre consigliate
  const fallbackStarts = [];
  const fallbackWindowStart = Math.max(notBefore, toMinutes("11:00"));
  const fallbackWindowEnd = Math.min(endLimit, toMinutes("15:30"));
  for (let start = fallbackWindowStart; start + LUNCH_DURATION <= fallbackWindowEnd; start += 5) {
    fallbackStarts.push(start);
  }

  const starts = [...preferredStarts, ...fallbackStarts];
  for (const start of starts) {
    const end = start + LUNCH_DURATION;
    if (start < notBefore || end > endLimit) continue;

    const added = addBlock(
      selected,
      {
        time: start,
        end,
        title: "PAUSA PRANZO CONSIGLIATA",
        location: "Punti ristoro / area picnic",
        reason: `PAUSA PRANZO CONSIGLIATA dalle ${fmtTime(start)} alle ${fmtTime(end)}`,
        score: priority,
        priority,
        kind: "lunch",
      },
      lunchGap
    );
    if (added) return true;
  }
  return false;
}

function enforceLunchForEligibleArrivals(
  selected,
  arrivalMins,
  endLimit,
  minGapMins = 0,
  fixedLunchRange = null
) {
  if (arrivalMins >= toMinutes("13:30")) return;
  if (selected.some((s) => s.kind === "lunch")) return;
  scheduleLunchBreak(selected, arrivalMins, endLimit, minGapMins, arrivalMins, fixedLunchRange, 2800);
}

function enforceAtLeastOneWellnessForAdults(selected, hasChildren, arrivalMins, endLimit, minGapMins = 0) {
  if (hasChildren) return;
  const hasWellness = selected.some(
    (s) => /Area Benessere/i.test(s.title)
  );
  if (hasWellness) return;
  const yin = getActivity("yin_yoga");
  const med = getActivity("meditazione_cuore");
  const targets = [yin, med].filter(Boolean);
  for (const a of targets) {
    const slot =
      findFixedStart(a.starts, 30, arrivalMins, selected, endLimit, 0, 0, 0, a.id) ||
      findRangeSlot(a, 30, arrivalMins, selected, endLimit, 0, 0, 0, a.id);
    if (!slot) continue;
    const added = addBlock(
      selected,
      {
        time: slot.time,
        end: slot.end,
        title: a.name,
        location: a.location,
        reason: WELLNESS_ADULT_NOTE,
        score: 3000,
        priority: 3000,
        slotUsageKey: slot.slotUsageKey,
      },
      0
    );
    if (added) return;
  }
}

function dedupeByActivityTitle(selected) {
  const ordered = [...selected].sort((a, b) => a.time - b.time || (b.priority || 0) - (a.priority || 0));
  const seen = new Set();
  const deduped = [];
  for (const item of ordered) {
    if (seen.has(item.title)) continue;
    seen.add(item.title);
    deduped.push(item);
  }
  return deduped;
}

function pickLunchRange(arrivalMins, endLimit, preferLateLunch = false) {
  if (arrivalMins >= toMinutes("13:30")) return null;
  const fixed = preferLateLunch ? [toMinutes("13:30"), toMinutes("11:30")] : [toMinutes("11:30"), toMinutes("13:30")];
  for (const start of fixed) {
    const end = start + 60;
    if (start >= arrivalMins && end <= endLimit) return { start, end };
  }
  return null;
}

function shouldIncludeMerlino(arrivalMins, requestedMins) {
  return arrivalMins <= toMinutes("12:00") && requestedMins >= 240;
}

function getBalloCastelloRanges() {
  return [
    [toMinutes("10:30"), toMinutes("12:00")],
    [toMinutes("13:30"), toMinutes("15:00")],
    [toMinutes("16:00"), toMinutes("17:00")],
  ];
}

function buildUnifiedInterestPlan(payload, arrivalMins, endLimit, interests, hasChildren, allowMerlino, kpopPreferredStart) {
  const core = new Set(interests.filter((i) => ["principesse", "maghi", "huntrix"].includes(i)));
  const hasChildUpTo7 = hasChildren && (payload.childrenAges || []).some((age) => Number(age) >= 1 && Number(age) <= 7);
  const lunch = pickLunchRange(arrivalMins, endLimit, kpopPreferredStart === "11:30");
  const selected = [];
  const candidates = [];
  const usedKeys = new Set();

  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;
  const isWellnessBlock = (block) => /Area Benessere|Yin Yoga|Meditazione del Cuore/i.test(block.title);
  const canPlace = (block) => {
    if (block.time < arrivalMins || block.end > endLimit) return false;
    const overlapping = selected.filter((s) => overlaps(block.time, block.end, s.time, s.end));
    if (!overlapping.length) return true;

    if (hasChildren && block.forChildren) {
      const wellnessOverlaps = overlapping.filter(isWellnessBlock);
      const nonWellnessOverlaps = overlapping.filter((s) => !isWellnessBlock(s));
      if (wellnessOverlaps.length > 0 && nonWellnessOverlaps.length === 0) {
        const parentAct = wellnessOverlaps[0].title.replace(/^Area Benessere\s*[–-]\s*/i, "").trim();
        block.preActivityText = `Mentre svolgi l'attività ${parentAct} i tuoi bambini possono partecipare a:`;
        return true;
      }
    }
    return false;
  };

  const place = (block) => {
    if (!canPlace(block)) return false;
    selected.push(block);
    return true;
  };

  const byUsageThenTime = (a, b) => {
    const ua = a.slotUsageKey ? getSlotUsage(a.slotUsageKey) : 0;
    const ub = b.slotUsageKey ? getSlotUsage(b.slotUsageKey) : 0;
    if (ua !== ub) return ua - ub;
    return Math.random() - 0.5;
  };

  const durationById = {
    principesse: 20,
    ballo_castello: 30,
    scuola_magia: 20,
    stanza_segreti_mago: 20,
    mago_merlino: 60,
    sentiero_incantato: 60,
    yin_yoga: 30,
    meditazione_cuore: 30,
    kpop: 40,
    bee_dance: 30,
    snoezelen: 20,
  };

  const colorById = {
    principesse: "blue",
    ballo_castello: "blue",
    scuola_magia: "brown",
    stanza_segreti_mago: "brown",
    mago_merlino: "brown",
    sentiero_incantato: "brown",
    kpop: "red",
    bee_dance: "black",
    yin_yoga: "green",
    meditazione_cuore: "green",
    snoezelen: "pink",
  };

  const basePriorityById = {
    kpop: 2000,
    bee_dance: 1900,
    yin_yoga: 1800,
    meditazione_cuore: 1790,
    snoezelen: 1780,
  };

  const addCandidate = (block) => {
    if (block.time >= block.end) return;
    if (block.time < arrivalMins || block.end > endLimit) return;
    const key = `${block.title}|${block.time}|${block.end}`;
    if (usedKeys.has(key)) return;
    usedKeys.add(key);
    candidates.push(block);
  };

  const addActivityById = (id, groupKey, basePriority = 900) => {
    const a = getActivity(id);
    if (!a) return;
    const duration = durationById[id] || 30;
    const colorKey = colorById[id] || "default";
    const reason =
      id === "bee_dance"
        ? "Animazione di un'ora: puoi arrivare quando vuoi (consigliati 30 minuti)."
        : id === "sentiero_incantato"
          ? "Prevedere una durata di circa 1 ora"
          : id === "yin_yoga" || id === "meditazione_cuore"
            ? WELLNESS_ADULT_NOTE
            : id === "snoezelen"
              ? "sessione consigliata per bambini 1-7 anni (durata 20 minuti)"
              : "attivita consigliata";
    const childFriendlyIds = new Set([
      "principesse",
      "ballo_castello",
      "snoezelen",
      "scuola_magia",
      "stanza_segreti_mago",
      "kpop",
      "bee_dance",
      "mago_merlino",
      "sentiero_incantato",
    ]);
    const forChildren = childFriendlyIds.has(id);

    const starts = id === "kpop" && kpopPreferredStart ? (a.starts || []).filter((s) => s === kpopPreferredStart) : a.starts || [];
    const orderedStarts = orderStartsByUsage(id, starts);
    orderedStarts.forEach((s) => {
      const start = toMinutes(s);
      const usageKey = slotKey(id, s);
      addCandidate({
        time: start,
        end: start + duration,
        title: a.name,
        location: a.location,
        reason,
        colorKey,
        groupKey,
        priority: basePriorityById[id] || basePriority,
        forChildren,
        slotUsageKey: usageKey,
      });
    });

    const ranges =
      id === "ballo_castello"
        ? getBalloCastelloRanges().map(([start, end]) => ({ start, end }))
        : (a.openRanges || []).map(([s, e]) => ({ start: toMinutes(s), end: toMinutes(e) }));
    ranges.forEach((range) => {
      const rangeStart = range.start;
      const rangeEnd = range.end;
      for (let start = rangeStart; start + duration <= rangeEnd; start += 10) {
        addCandidate({
          time: start,
          end: start + duration,
          title: a.name,
          location: a.location,
          reason,
          colorKey,
          groupKey,
          priority: basePriorityById[id] || basePriority,
          forChildren,
        });
      }
    });

    (a.subActivities || []).forEach((sub) => {
      const subKeyBase = `${id}_${sub.id || sub.name}`;
      orderStartsByUsage(subKeyBase, sub.starts || []).forEach((s) => {
        const start = toMinutes(s);
        const end = start + (sub.durationMins || 20);
        const usageKey = slotKey(subKeyBase, s);
        addCandidate({
          time: start,
          end,
          title: `${sub.name} (${a.name})`,
          location: a.location,
          reason: "attivita consigliata",
          colorKey,
          groupKey,
          priority: basePriority + 20,
          forChildren,
          slotUsageKey: usageKey,
        });
      });
    });
  };

  if (core.has("principesse")) {
    addActivityById("principesse", "principesse", 1200);
    addActivityById("ballo_castello", "principesse", 1180);
  }
  if (core.has("maghi")) {
    addActivityById("scuola_magia", "maghi", 1150);
    addActivityById("stanza_segreti_mago", "maghi", 1140);
    if (allowMerlino) {
      addActivityById("mago_merlino", "maghi", 2600);
      addActivityById("sentiero_incantato", "maghi", 2590);
    }
  }
  if (core.has("huntrix")) {
    addActivityById("kpop", "huntrix", 2000);
    addActivityById("bee_dance", "huntrix", 1900);
  }

  // Sempre presenti se compatibili nella fascia.
  addActivityById("kpop", "always", 2000);
  addActivityById("bee_dance", "always", 1900);
  addActivityById("yin_yoga", "wellness", 1800);
  addActivityById("meditazione_cuore", "wellness", 1790);
  if (hasChildUpTo7) addActivityById("snoezelen", "kids", 1780);

  if (lunch) {
    place({
      time: lunch.start,
      end: lunch.end,
      title: "PAUSA PRANZO CONSIGLIATA",
      location: "Punti ristoro / area picnic",
      reason: `PAUSA PRANZO CONSIGLIATA dalle ${fmtTime(lunch.start)} alle ${fmtTime(lunch.end)}`,
      kind: "lunch",
      colorKey: "red",
      priority: 5000,
    });
  }

  // 1) Priorita assoluta: spettacoli.
  const requiredShowIds = ["kpop", "bee_dance"];
  requiredShowIds.forEach((id) => {
    const showBlocks = candidates
      .filter((c) => c.groupKey && (id === "kpop" ? /K-POP/i.test(c.title) : /BEE-Dance|Ape Maia/i.test(c.title)))
      .sort(byUsageThenTime);
    for (const block of showBlocks) {
      place(block);
    }
  });

  // 2) Benessere sempre per genitori/adulti.
  ["yin_yoga", "meditazione_cuore"].forEach((id) => {
    const blocks = candidates
      .filter((c) => id === "yin_yoga" ? /Yin Yoga/i.test(c.title) : /Meditazione del Cuore/i.test(c.title))
      .sort(byUsageThenTime);
    for (const block of blocks) {
      if (place(block)) break;
    }
  });

  // 3) Snoezelen (rosa) con bimbi fino a 7 anni.
  if (hasChildUpTo7) {
    const blocks = candidates.filter((c) => /Snoezelen/i.test(c.title)).sort(byUsageThenTime);
    for (const block of blocks) {
      if (place(block)) break;
    }
  }

  // 4) Garantisci almeno una attività per ogni area interesse selezionata.
  const groupPriority = ["principesse", "maghi", "huntrix"];
  groupPriority.forEach((group) => {
    if (!core.has(group)) return;
    const hasGroup = selected.some((s) => s.groupKey === group);
    if (hasGroup) return;
    const blocks = candidates
      .filter((c) => c.groupKey === group)
      .sort((a, b) => b.priority - a.priority || byUsageThenTime(a, b));
    for (const block of blocks) {
      if (place(block)) break;
    }
  });

  // 4b) Con preferenza Maghi e soglia valida, Merlino+Sentiero devono stare sempre insieme.
  if (core.has("maghi") && allowMerlino) {
    enforceMerlinoSentieroTogether(selected, arrivalMins, endLimit, 0, true);
  }

  // 4c) Con preferenza Principesse, Ballo nel Castello deve essere sempre presente.
  if (core.has("principesse")) {
    const hasBallo = selected.some((s) => /Ballo nel Castello/i.test(s.title));
    if (!hasBallo) {
      const balloOptions = candidates
        .filter((c) => /Ballo nel Castello/i.test(c.title))
        .sort((a, b) => b.priority - a.priority || byUsageThenTime(a, b));
      let inserted = false;
      for (const option of balloOptions) {
        if (place(option)) {
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        for (const option of balloOptions) {
          const conflicting = selected.filter((s) => overlaps(option.time, option.end, s.time, s.end));
          const canReplace =
            conflicting.length > 0 &&
            conflicting.every((s) => s.kind !== "lunch" && (s.priority || 0) < (option.priority || 0));
          if (!canReplace) continue;
          conflicting.forEach((s) => {
            const idx = selected.indexOf(s);
            if (idx >= 0) selected.splice(idx, 1);
          });
          if (place(option)) {
            break;
          }
        }
      }
    }
  }

  // 5) Riempimento: massimizza attività senza sovrapposizioni.
  candidates
    .sort((a, b) => a.end - b.end || b.priority - a.priority || byUsageThenTime(a, b))
    .forEach((block) => place(block));

  const bestByTitle = new Map();
  selected.forEach((s) => {
    const current = bestByTitle.get(s.title);
    if (!current) {
      bestByTitle.set(s.title, s);
      return;
    }
    const currUsage = current.slotUsageKey ? getSlotUsage(current.slotUsageKey) : 0;
    const nextUsage = s.slotUsageKey ? getSlotUsage(s.slotUsageKey) : 0;
    if (nextUsage < currUsage || (nextUsage === currUsage && s.time < current.time)) {
      bestByTitle.set(s.title, s);
    }
  });
  const unique = [...bestByTitle.values()].sort((a, b) => a.time - b.time || a.title.localeCompare(b.title));
  unique.forEach((u) => {
    if (u.slotUsageKey) recordSlotUsage(u.slotUsageKey);
  });

  return unique.map((s) => ({
      start: fmtTime(s.time),
      end: fmtTime(s.end),
      activity: s.title,
      location: s.location,
      note: s.reason,
      preActivityText: s.preActivityText || "",
      kind: s.kind || "activity",
      colorKey: s.colorKey || "default",
    }));
}

function buildCandidateBlocks(
  arrivalMins,
  endLimit,
  context,
  selected,
  minGapMins = 0,
  includeAllUntilClose = false,
  allowMerlino = true
) {
  const blocks = [];
  programData.activities.forEach((a) => {
    if (!allowMerlino && a.id === "mago_merlino") return;
    if (a.id === "sentiero_incantato" || a.id === "kpop" || a.id === "bee_dance") return;

    // Attivita con inizio preciso
    if (a.starts?.length) {
      a.starts.forEach((s) => {
        const t = toMinutes(s);
        if (t < arrivalMins) return;
        const duration = a.id === "kpop" ? 40 : a.id === "bee_dance" ? 30 : 30;
        if (t + duration > endLimit) return;
        blocks.push({
          time: t,
          end: t + duration,
          title: a.name,
          location: a.location,
          reason:
            a.id === "yin_yoga" || a.id === "meditazione_cuore"
              ? "attivita consigliata per genitori - adulti"
              : "attivita consigliata",
          score: scoreActivity(a, context),
          bufferBefore: a.id === "kpop" || a.id === "bee_dance" ? 15 : 0,
          bufferAfter: a.id === "kpop" || a.id === "bee_dance" ? 15 : 0,
        priority: 100,
        });
      });
      return;
    }

    // Attivita in range senza start fisso
    const slot = findRangeSlot(a, 30, arrivalMins, selected, endLimit, minGapMins);
    if (!slot) return;
    blocks.push({
      time: slot.time,
      end: slot.end,
      title: a.name,
      location: a.location,
      reason:
        a.id === "yin_yoga" || a.id === "meditazione_cuore"
          ? "attivita consigliata per genitori - adulti"
          : "attivita consigliata",
      score: scoreActivity(a, context),
      priority: 100,
    });
  });

  if (includeAllUntilClose) {
    return blocks.sort((a, b) => a.time - b.time || b.score - a.score);
  }
  return blocks.sort((a, b) => b.score - a.score || a.time - b.time);
}

function uniqueSortedStrings(values = []) {
  return [...new Set(values)].sort((a, b) => toMinutes(a) - toMinutes(b));
}

function getStartsInWindow(activity, arrivalMins, endLimit) {
  return uniqueSortedStrings(
    (activity?.starts || []).filter((s) => {
      const t = toMinutes(s);
      return t >= arrivalMins && t <= endLimit;
    })
  );
}

function getSubActivityStartsInWindow(activity, matcher, arrivalMins, endLimit) {
  const sub = (activity?.subActivities || []).find((s) => matcher.test(s.name));
  if (!sub?.starts?.length) return [];
  return uniqueSortedStrings(
    sub.starts.filter((s) => {
      const t = toMinutes(s);
      return t >= arrivalMins && t <= endLimit;
    })
  );
}

function getRangesInWindow(activity, arrivalMins, endLimit) {
  const out = [];
  (activity?.openRanges || []).forEach(([s, e]) => {
    const start = Math.max(toMinutes(s), arrivalMins);
    const end = Math.min(toMinutes(e), endLimit);
    if (start < end) out.push(`${fmtTime(start)} - ${fmtTime(end)}`);
  });
  return uniqueSortedStrings(out.map((r) => r.split(" - ")[0])).map((startText) => {
    return out.find((r) => r.startsWith(startText));
  }).filter(Boolean);
}

function addSeparator(itinerary) {
  if (!itinerary.length) return;
  itinerary.push({
    kind: "separator",
    activity: "",
    location: "",
    note: "",
    start: "",
    end: "",
    colorKey: "default",
  });
}

function addSection(itinerary, title, colorKey = "default", note = "") {
  itinerary.push({
    kind: "section",
    activity: title,
    location: "",
    note,
    start: "",
    end: "",
    colorKey,
  });
}

function addItem(itinerary, { activity, location = "", note = "", colorKey = "default", kind = "item" }) {
  itinerary.push({
    kind,
    activity,
    location,
    note,
    start: "",
    end: "",
    colorKey,
  });
}

function formatTimesLabel(times = []) {
  return times.length ? `Orari: ${times.join(", ")}` : "Nessun orario disponibile nella fascia selezionata";
}

function formatRangesLabel(ranges = []) {
  return ranges.length ? `Aperture in fascia: ${ranges.join(" | ")}` : "Nessuna apertura disponibile nella fascia selezionata";
}

function pickLunchSuggestion(arrivalMins, endLimit) {
  const preferred = { start: toMinutes("11:30"), end: toMinutes("12:30") };
  const alt = { start: toMinutes("13:30"), end: toMinutes("14:30") };
  const canUse = (slot) => slot.start >= arrivalMins && slot.end <= endLimit;
  const preferredAvailable = canUse(preferred);
  const altAvailable = canUse(alt);
  if (preferredAvailable && (Math.random() < 0.6 || !altAvailable)) return preferred;
  if (altAvailable) return alt;
  const fallbackStart = Math.max(arrivalMins, toMinutes("11:30"));
  const fallbackEnd = fallbackStart + 60;
  if (fallbackEnd <= endLimit) return { start: fallbackStart, end: fallbackEnd };
  return null;
}

function buildPersonalPlan(payload) {
  const hasChildren = payload.hasChildren === true;
  const childrenAges = (payload.childrenAges || []).map((n) => Number(n)).filter((n) => !Number.isNaN(n));
  const arrivalTime = payload.arrivalTime || "10:00";
  const visitDate = payload.visitDate || "";
  const arrivalMins = toMinutes(arrivalTime);
  const parkCloseMins = toMinutes(programData.gates.parkClose || "17:30");
  const availableMins = Math.max(0, parkCloseMins - arrivalMins);
  const requestedMins = getStayDurationMinutes(payload.stayDuration, availableMins);
  const endLimit = arrivalMins + requestedMins;
  const interests = normalizeInterests(payload.interests || []);
  const hasChildUpTo7 = hasChildren && childrenAges.some((age) => age >= 1 && age <= 7);
  const itinerary = [];

  const kpop = getActivity("kpop");
  const bee = getActivity("bee_dance");
  const snoezelen = getActivity("snoezelen");
  const principesse = getActivity("principesse");
  const ballo = getActivity("ballo_castello");
  const scuola = getActivity("scuola_magia");
  const stanza = getActivity("stanza_segreti_mago");
  const yin = getActivity("yin_yoga");
  const med = getActivity("meditazione_cuore");
  const sentiero = getActivity("sentiero_incantato");
  const merlino = getActivity("mago_merlino");

  addSection(itinerary, "In questi orari puoi scegliere tra le seguenti attività", "default");
  addSeparator(itinerary);

  addSection(
    itinerary,
    "SPETTACOLI",
    "red",
    "Per raggiungere l'Area Spettacoli scendere per circa 200 mt. nella parte inferiore del Parco, cancello sulla destra osservando il Castello."
  );
  addItem(itinerary, {
    activity: kpop?.name || "Spettacolo K-POP",
    location: kpop?.location || "",
    note: `${formatTimesLabel(getStartsInWindow(kpop, arrivalMins, endLimit))}. Durata circa 40 minuti`,
    colorKey: "red",
  });
  addItem(itinerary, {
    activity: bee?.name || "BEE-Dance con Ape Maia",
    location: bee?.location || "",
    note: `${formatRangesLabel(
      getRangesInWindow(bee, arrivalMins, endLimit)
    )}. L'attività dura un'ora, puoi unirti quando vuoi e ballare con le musiche del Musical ufficiale per i 50 anni dell'Ape Maia.`,
    colorKey: "black",
  });

  if (hasChildUpTo7) {
    addSeparator(itinerary);
    addSection(itinerary, "BAMBINI FINO A 7 ANNI - STANZA SNOEZELEN", "pink");
    addItem(itinerary, {
      activity: snoezelen?.name || "Stanza Snoezelen per bambini",
      location: snoezelen?.location || "",
      note: formatTimesLabel(getStartsInWindow(snoezelen, arrivalMins, endLimit)),
      colorKey: "pink",
    });
  }

  if (interests.includes("principesse")) {
    addSeparator(itinerary);
    addSection(itinerary, "PRINCIPESSE", "blue");
    addItem(itinerary, {
      activity: principesse?.name || "Giardino delle Principesse",
      location: principesse?.location || "",
      note: formatRangesLabel(getRangesInWindow(principesse, arrivalMins, endLimit)),
      colorKey: "blue",
    });
    addItem(itinerary, {
      activity: ballo?.name || "Ballo nel Castello",
      location: ballo?.location || "",
      note: formatRangesLabel(getRangesInWindow(ballo, arrivalMins, endLimit)),
      colorKey: "blue",
    });
  }

  if (interests.includes("maghi")) {
    addSeparator(itinerary);
    addSection(itinerary, "MAGHI", "brown");
    addItem(itinerary, {
      activity: scuola?.name || "Scuola di Magia",
      location: scuola?.location || "",
      note: formatRangesLabel(getRangesInWindow(scuola, arrivalMins, endLimit)),
      colorKey: "brown",
    });
    const pozioni = formatTimesLabel(getSubActivityStartsInWindow(scuola, /pozioni/i, arrivalMins, endLimit));
    const difesa = formatTimesLabel(getSubActivityStartsInWindow(scuola, /difesa/i, arrivalMins, endLimit));
    addItem(itinerary, {
      activity: "Lezioni di Magia",
      location: scuola?.location || "",
      note: `Pozioni: ${pozioni.replace(/^Orari:\s*/, "")} | Difesa: ${difesa.replace(/^Orari:\s*/, "")}`,
      colorKey: "brown",
    });
    addItem(itinerary, {
      activity: stanza?.name || "Stanza dei segreti del Mago",
      location: stanza?.location || "",
      note: formatRangesLabel(getRangesInWindow(stanza, arrivalMins, endLimit)),
      colorKey: "brown",
    });
    addItem(itinerary, {
      activity: "Mini Torneo (Stanza dei segreti)",
      location: stanza?.location || "",
      note: formatTimesLabel(getSubActivityStartsInWindow(stanza, /mini torneo/i, arrivalMins, endLimit)),
      colorKey: "brown",
    });
  }

  if (interests.includes("huntrix")) {
    addSeparator(itinerary);
    addSection(itinerary, "HUNTRIX", "red");
    addItem(itinerary, {
      activity: kpop?.name || "Spettacolo K-POP",
      location: kpop?.location || "",
      note: formatTimesLabel(getStartsInWindow(kpop, arrivalMins, endLimit)),
      colorKey: "red",
    });
  }

  addSeparator(itinerary);
  addSection(
    itinerary,
    "OASI BENESSERE GENITORI",
    "green",
    "1 Pass benessere per adulto incluso. Seconda attività benessere solo se disponibili posti liberi ad inizio sessione."
  );
  addItem(itinerary, {
    activity: yin?.name || "Area Benessere - Yin Yoga",
    location: yin?.location || "",
    note: `${formatTimesLabel(getStartsInWindow(yin, arrivalMins, endLimit))}. Attività consigliata per genitori - adulti.`,
    colorKey: "green",
  });
  addItem(itinerary, {
    activity: med?.name || "Area Benessere - Meditazione del Cuore",
    location: med?.location || "",
    note: `${formatTimesLabel(getStartsInWindow(med, arrivalMins, endLimit))}. Attività consigliata per genitori - adulti.`,
    colorKey: "green",
  });

  const lunchSlot = pickLunchSuggestion(arrivalMins, endLimit);
  if (lunchSlot) {
    addItem(itinerary, {
      activity: "ORARIO CONSIGLIATO PRANZO",
      location: "Punti ristoro / area picnic",
      note: `${fmtTime(lunchSlot.start)} - ${fmtTime(lunchSlot.end)}`,
      colorKey: "red",
      kind: "lunch",
    });
  }

  addSeparator(itinerary);
  addSection(itinerary, "Passeggiata nel Parco (prevedere circa 1 ora)", "brown");
  addItem(itinerary, {
    activity: "Sentiero Incantato + Casa di Mago Merlino",
    location: "Parco",
    note: `Sentiero: ${formatRangesLabel(getRangesInWindow(sentiero, arrivalMins, endLimit)).replace(
      "Aperture in fascia: ",
      ""
    )} | Mago Merlino: ${formatRangesLabel(getRangesInWindow(merlino, arrivalMins, endLimit)).replace(
      "Aperture in fascia: ",
      ""
    )}`,
    colorKey: "brown",
  });

  const summary = "";
  return {
    event: programData.eventName,
    introNote: INTRO_ITALIC_NOTE,
    metadata: {
      visitDate,
      hasChildren,
      childrenAges,
      interests,
      arrivalTime,
      stayDuration: payload.stayDuration,
    },
    summary,
    itinerary,
    finalNote: FINAL_BOLD_NOTE,
  };
}

module.exports = { buildPersonalPlan };
