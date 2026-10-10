/**
 * Export PDF par l'impression du navigateur.
 *
 * On n'embarque aucune bibliothèque PDF : on ouvre une fenêtre avec une
 * mise en page soignée, prête à imprimer, et le navigateur propose
 * « Enregistrer au format PDF ». Léger, fiable, et le rendu est celui du
 * navigateur que l'utilisateur connaît déjà.
 *
 * Le titre du document n'est jamais inventé ici : il est fourni par
 * l'appelant, qui le tire des libellés d'état déjà définis dans l'app.
 */

export interface EnTeteSite {
  activite?: string | null;
  site?: string | null;
  adresse?: string | null;
  numero?: string | null;
  imageUrl?: string | null;
}

export interface LigneDocument {
  /** Chaque cellule de la ligne, dans l'ordre des colonnes. */
  cellules: (string | number)[];
}

export interface TotalDocument {
  libelle: string;
  valeur: string;
  /** Met la ligne en gras : le montant qui conclut le document. */
  fort?: boolean;
}

export interface DocumentPdf {
  /** Le nom du document, selon son état (ex. « Facture », « Devis »…). */
  titre: string;
  /** La référence du dossier (ex. CV261009-WK3Z). */
  reference: string;
  /** Bloc d'informations clés : partenaire, dates… (libellé → valeur). */
  infos: { libelle: string; valeur: string }[];
  /** Les en-têtes des colonnes du tableau. */
  colonnes: string[];
  /** Les lignes du tableau. */
  lignes: LigneDocument[];
  /** Les totaux, en bas à droite. */
  totaux: TotalDocument[];
  /** Une note libre, en bas du document. */
  note?: string | null;
  /** L'en-tête de l'activité / du site. */
  entete: EnTeteSite;
  /** Alignement des colonnes (par défaut « left », « right » pour l'argent). */
  alignements?: ('left' | 'center' | 'right')[];
}

function echapper(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function dateDuJour(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * Ouvre une fenêtre d'impression avec le document mis en page, et lance
 * l'impression. L'utilisateur choisit « Enregistrer au format PDF ».
 */
export function exporterPdf(doc: DocumentPdf): void {
  const { entete } = doc;
  const align = (i: number) =>
    doc.alignements?.[i] ?? 'left';

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${echapper(doc.titre)} ${echapper(doc.reference)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a2e;
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .doc { max-width: 720px; margin: 0 auto; padding: 24px 0; }

  /* En-tête : l'activité et le site à gauche, le document à droite. */
  .haut {
    display: flex; justify-content: space-between; align-items: flex-start;
    gap: 24px; padding-bottom: 20px; border-bottom: 2px solid #4f46e5;
  }
  .ident { display: flex; gap: 14px; align-items: center; }
  .logo { width: 56px; height: 56px; object-fit: cover; border-radius: 10px; }
  .activite { font-size: 17px; font-weight: 800; letter-spacing: -.3px; }
  .site { font-size: 13px; font-weight: 700; color: #4f46e5; margin-top: 2px; }
  .coord { font-size: 11px; color: #6b7280; margin-top: 3px; }
  .bloc-titre { text-align: right; }
  .titre {
    font-size: 20px; font-weight: 800; letter-spacing: -.4px;
    text-transform: uppercase; color: #4f46e5;
  }
  .ref { font-size: 13px; font-weight: 700; margin-top: 3px; }
  .date-emission { font-size: 11px; color: #6b7280; margin-top: 2px; }

  /* Informations clés : partenaire, dates. */
  .infos {
    display: grid; grid-template-columns: repeat(2, 1fr);
    gap: 8px 24px; margin: 22px 0;
  }
  .info-l { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: #9ca3af; }
  .info-v { font-size: 13px; font-weight: 600; }

  /* Tableau de la marchandise. */
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead th {
    background: #4f46e5; color: #fff; font-size: 10.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .4px; padding: 9px 10px;
    text-align: left;
  }
  thead th.r { text-align: right; }
  thead th.c { text-align: center; }
  tbody td { padding: 9px 10px; border-bottom: 1px solid #eceef3; }
  tbody td.r { text-align: right; }
  tbody td.c { text-align: center; }
  tbody tr:nth-child(even) td { background: #fafbfc; }

  /* Totaux. */
  .totaux { margin-top: 18px; display: flex; justify-content: flex-end; }
  .totaux-bloc { min-width: 260px; }
  .total-l {
    display: flex; justify-content: space-between; padding: 6px 2px;
    font-size: 13px; border-bottom: 1px solid #eceef3;
  }
  .total-l.fort {
    font-weight: 800; font-size: 15px; border-bottom: none;
    border-top: 2px solid #1a1a2e; margin-top: 4px; padding-top: 10px;
  }
  .total-l .lib { color: #6b7280; }
  .total-l.fort .lib { color: #1a1a2e; }

  .note {
    margin-top: 26px; padding: 12px 14px; background: #f7f8fa;
    border-radius: 8px; font-size: 11.5px; color: #4b5563;
    border-left: 3px solid #4f46e5;
  }
  .pied {
    margin-top: 34px; padding-top: 14px; border-top: 1px solid #eceef3;
    text-align: center; font-size: 10px; color: #9ca3af;
  }
</style>
</head>
<body>
  <div class="doc">
    <div class="haut">
      <div class="ident">
        ${entete.imageUrl ? `<img class="logo" src="${echapper(entete.imageUrl)}" alt="" />` : ''}
        <div>
          ${entete.activite ? `<div class="activite">${echapper(entete.activite)}</div>` : ''}
          ${entete.site ? `<div class="site">${echapper(entete.site)}</div>` : ''}
          ${entete.adresse ? `<div class="coord">${echapper(entete.adresse)}</div>` : ''}
          ${entete.numero ? `<div class="coord">Tél. ${echapper(entete.numero)}</div>` : ''}
        </div>
      </div>
      <div class="bloc-titre">
        <div class="titre">${echapper(doc.titre)}</div>
        <div class="ref">${echapper(doc.reference)}</div>
        <div class="date-emission">Émis le ${dateDuJour()}</div>
      </div>
    </div>

    ${doc.infos.length ? `<div class="infos">
      ${doc.infos.map(i => `<div>
        <div class="info-l">${echapper(i.libelle)}</div>
        <div class="info-v">${echapper(i.valeur)}</div>
      </div>`).join('')}
    </div>` : ''}

    <table>
      <thead>
        <tr>${doc.colonnes.map((c, i) =>
          `<th class="${align(i) === 'right' ? 'r' : align(i) === 'center' ? 'c' : ''}">${echapper(c)}</th>`
        ).join('')}</tr>
      </thead>
      <tbody>
        ${doc.lignes.map(l => `<tr>${l.cellules.map((cel, i) =>
          `<td class="${align(i) === 'right' ? 'r' : align(i) === 'center' ? 'c' : ''}">${echapper(cel)}</td>`
        ).join('')}</tr>`).join('')}
      </tbody>
    </table>

    ${doc.totaux.length ? `<div class="totaux"><div class="totaux-bloc">
      ${doc.totaux.map(t => `<div class="total-l ${t.fort ? 'fort' : ''}">
        <span class="lib">${echapper(t.libelle)}</span>
        <span>${echapper(t.valeur)}</span>
      </div>`).join('')}
    </div></div>` : ''}

    ${doc.note ? `<div class="note">${echapper(doc.note)}</div>` : ''}

    <div class="pied">Document généré par IBD Kunda${entete.activite ? ` — ${echapper(entete.activite)}` : ''}</div>
  </div>
</body>
</html>`;

  /* On imprime depuis un cadre invisible intégré à la page, au lieu d'une
     nouvelle fenêtre : les navigateurs bloquent souvent les fenêtres
     ouvertes par un clic, et le bouton semblait alors ne rien faire. Le
     cadre caché n'est pas un pop-up — rien à autoriser. */
  const cadre = document.createElement('iframe');
  cadre.style.position = 'fixed';
  cadre.style.right = '0';
  cadre.style.bottom = '0';
  cadre.style.width = '0';
  cadre.style.height = '0';
  cadre.style.border = '0';
  document.body.appendChild(cadre);

  const docCadre = cadre.contentWindow?.document;
  if (!docCadre) {
    document.body.removeChild(cadre);
    return;
  }
  docCadre.open();
  docCadre.write(html);
  docCadre.close();

  /* Le `window.print()` du HTML est retiré ici : c'est ce cadre qui
     imprime, une fois son contenu chargé. On retire le cadre après. */
  const lancer = () => {
    try {
      cadre.contentWindow?.focus();
      cadre.contentWindow?.print();
    } catch { /* rien à faire si l'impression est annulée */ }
    setTimeout(() => {
      if (cadre.parentNode) cadre.parentNode.removeChild(cadre);
    }, 1000);
  };
  /* Laisser le temps aux images (logo) de se charger avant d'imprimer. */
  setTimeout(lancer, 350);
}
