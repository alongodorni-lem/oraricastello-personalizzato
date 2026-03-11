/**
 * Configurazione segmenti per SMS promozionali
 * Lista A: ha prenotato evento target
 * Lista B: ha prenotato altri eventi (ultimi 18 mesi)
 * Lista C: nessuna prenotazione (ultimi 18 mesi)
 */
module.exports = {
  // Numero admin: riceve un SMS di conferma a ogni campagna inviata
  adminPhone: '+393394773418',
  // Risorsa Planyo dell'evento target (es. Castello delle Sorprese 2026)
  targetResourceId: 236955,

  // Mesi di lookback per storico prenotazioni
  monthsLookback: 18,

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
    listC: 'Scopri il Castello delle Sorprese - un\'avventura magica per tutta la famiglia. Prenota ora: https://www.planyo.com/booking.php?calendar=8895'
  }
};
