'use client';
import { formatMontant } from '@/lib/format';

/**
 * Le résumé de l'onglet Partenaires.
 *
 * Trois chiffres et pas un de plus : ce qui reste dû en grand, parce que
 * c'est la seule ligne sur laquelle on peut encore agir ; le total et le
 * versé en dessous, parce qu'un reste sans son total ne dit pas s'il est
 * grave ; le nombre de partenaires concernés, parce que 500 000 dus par un
 * seul client et par vingt ne se traitent pas de la même façon.
 *
 * La barre mesure le versé sur le total. Elle était auparavant toujours
 * vide : le versé était écrit en dur à zéro.
 */
export default function PartenairesResumeCard({
  role, reste, verse, retour = 0, nbDus, nbTotal, onOuvrir,
}: {
  role: 'client' | 'fournisseur';
  /** ce qui reste à recouvrer (clients) ou à régler (fournisseurs) */
  reste: number;
  /** l'argent qui a réellement circulé */
  verse: number;
  /**
   * Ce que la marchandise rendue a éteint, sans argent.
   *
   * Il a sa ligne, jamais celle du versé : un retour fait baisser la
   * dette, il ne remplit aucune caisse. Les additionner faisait dire à
   * l'écran qu'on avait encaissé ce qu'on n'avait jamais reçu.
   */
  retour?: number;
  /** combien de partenaires portent encore un reste */
  nbDus: number;
  /** combien de partenaires ont ce rôle */
  nbTotal: number;
  onOuvrir?: () => void;
}) {
  const estFourn = role === 'fournisseur';
  const total = reste + verse + retour;
  /* La barre mesure ce qui a éteint la dette, par l'argent comme par la
     marchandise : c'est ce qui reste à faire qui l'intéresse. */
  const eteint = verse + retour;
  /* Tant qu'il reste un franc à recouvrer, on n'écrit pas 100 % : sur un gros
     volume, l'arrondi affichait une barre pleine à côté d'un reste non nul. */
  const brut = total > 0 ? (eteint / total) * 100 : 0;
  const pct = total === 0 ? 0 : reste > 0 ? Math.min(Math.floor(brut), 99) : 100;

  /* Hors d'un site, il n'y a pas de page de transactions où aller : la
     carte reste lisible mais cesse de se donner pour un bouton. Un survol
     qui promet un clic sans effet fait douter de l'écran. */
  return (
    <button
      type="button"
      onClick={onOuvrir}
      disabled={!onOuvrir}
      className={`block w-full text-left bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 mb-4 transition-colors ${
        onOuvrir
          ? 'hover:border-indigo-200 dark:hover:border-indigo-800'
          : 'cursor-default'}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase text-gray-900 dark:text-gray-100">
            {estFourn ? 'Dettes à régler' : 'Créances à recouvrer'}
          </p>
          {/* Un reste nul n'est pas une alerte : rien à réclamer, rien à
              colorer. La couleur ne sert qu'à ce qui appelle une action. */}
          <p className={`text-2xl font-bold mt-0.5 ${
            reste > 0
              ? estFourn ? 'text-red-600' : 'text-orange-500'
              : 'text-gray-900 dark:text-gray-100'}`}>
            {formatMontant(reste)}
          </p>
        </div>

        <span className="shrink-0 px-2.5 py-1 bg-gray-100 dark:bg-gray-800 rounded-lg text-xs font-bold text-gray-500 dark:text-gray-400">
          {nbDus > 0
            ? `${nbDus} / ${nbTotal} non soldé${nbDus > 1 ? 's' : ''}`
            : `${nbTotal} ${estFourn ? 'fournisseur' : 'client'}${nbTotal > 1 ? 's' : ''}`}
        </span>
      </div>

      <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full mt-3 overflow-hidden">
        <div className="h-full rounded-full bg-green-500 transition-all"
          style={{ width: `${pct}%` }} />
      </div>

      <p className="text-xs text-gray-400 mt-1.5">
        Total {formatMontant(total)}
        {' · '}
        <span className="text-green-600 dark:text-green-400 font-medium">
          {estFourn ? 'Payé' : 'Encaissé'} {formatMontant(verse)}
        </span>
        {/* Le retour ne paraît que s'il existe : une ligne à zéro
            encombrerait tous les sites qui n'en font jamais. */}
        {retour > 0 && (
          <>
            {' · '}
            <span className="font-medium text-amber-600 dark:text-amber-400">
              Retour {formatMontant(retour)}
            </span>
          </>
        )}
        {total > 0 && <span>{' · '}{pct}%</span>}
      </p>
    </button>
  );
}
