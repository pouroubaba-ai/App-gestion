/**
 * Une ligne de total : le libellé, des pointillés, le chiffre.
 *
 * Les pointillés ne sont pas un ornement. Ils relient l'œil du mot au
 * nombre sur toute la largeur, là où un simple espace laisse hésiter
 * entre deux lignes voisines — et l'on vérifie un montant en le suivant
 * du doigt, pas en le devinant.
 *
 * Le même bloc apparaissait recopié sur la fiche d'achat et celle de
 * vente, avec déjà deux signatures différentes. Un troisième exemplaire
 * aurait fini par diverger à son tour.
 */
export default function LigneTotal({
  label,
  valeur,
  classeValeur = 'font-medium text-gray-900 dark:text-gray-100',
}: {
  label: React.ReactNode;
  valeur: string;
  classeValeur?: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-gray-400">{label}</span>
      <span className="flex-1 border-b border-dotted border-gray-200 dark:border-gray-700" />
      <span className={`shrink-0 whitespace-nowrap ${classeValeur}`}>{valeur}</span>
    </div>
  );
}
