/* pdf.js:n työntekijä, paikattuna.

   Työntekijällä on oma globaali ympäristönsä, joten pääsäikeen paikkaus ei
   näy tänne: `Promise.withResolvers` on lisättävä uudelleen ennen kuin
   varsinainen työntekijämoduuli ladataan. Ks. js/polyfill.js.

   Tämä tiedosto on kirjoitettu käsin eikä tule pdfjs-distin mukana — sitä
   ei siis pidä ylikirjoittaa pdf.js:ää päivitettäessä. */

if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

await import('./pdf.worker.min.mjs');
