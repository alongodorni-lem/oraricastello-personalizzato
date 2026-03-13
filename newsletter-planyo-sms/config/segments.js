/**
 * Configurazione segmenti per SMS promozionali
 * Lista A: prenotati evento target ultimi 6 mesi (API Planyo)
 * Lista B: prenotazioni ultimi 18 mesi esclusi evento target ultimi 6 mesi (API Planyo)
 * Lista C: click newsletter esclusi evento target ultimi 6 mesi (Mailchimp)
 * Lista D: CSV Planyo esclusi evento target ultimi 6 mesi
 */
module.exports = {
  // Numero admin: riceve un SMS di conferma a ogni campagna inviata
  adminPhone: '+393394773418',
  // Risorsa Planyo dell'evento target (es. Castello delle Sorprese 2026)
  targetResourceId: 236955,

  // Mesi lookback evento target (Lista A)
  targetMonthsLookback: parseInt(process.env.PLANYO_TARGET_MONTHS, 10) || 6,
  // Mesi lookback per Lista B (prenotazioni altri eventi)
  monthsLookback: parseInt(process.env.PLANYO_MONTHS_LOOKBACK, 10) || 18,

  // Etichette risorse (per log)
  resourceLabels: {
    236955: 'Castello 2026',
    243693: 'Grotta 2026',
    175117: 'Sirene',
    243671: 'Risorsa 243671',
    245130: 'Risorsa 245130'
  },

  // Testi SMS per ciascuna lista (personalizzabili)
  smsTexts: {
    listA: 'Grazie! Hai già prenotato il Castello. Scopri le novità e le date 2026: https://www.planyo.com/booking.php?calendar=8895',
    listB: 'Ultime 48 ore! Promo -6 euro a persona. Castello delle Sorprese: Principesse, Maghi, K-Pop, yoga e relax per genitori. Prenota: www.castellodellesorprese.it',
    listC: 'Scopri il Castello delle Sorprese - un\'avventura magica per tutta la famiglia. Prenota ora: https://www.planyo.com/booking.php?calendar=8895',
    listD: 'Newsletter Castello delle Sorprese 2026. Scopri le novità e le date: https://www.planyo.com/booking.php?calendar=8895'
  }
};
