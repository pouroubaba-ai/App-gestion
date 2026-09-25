'use client';
import { useEffect, useState } from 'react';
import { formatMontant } from '@/lib/format';
import { coutMoyenApresEntree, enUnitesBase } from '@/lib/mouvements';
import { Trash2, Package, Info, Plus, Minus, BarChart3 } from 'lucide-react';
import { ChampRecherche, ChampNombre } from '@/components/Champs';
import type { LigneFlux } from '@/lib/flux-marchandise';
import ModalMargeRecu from './ModalMargeRecu';

export interface ProduitChoisissable {
  id: string;
  designation: string;
  categorie?: string;
  unite?: string;
  coutMoyen: number;
  prixVente?: number;
  stock?: number;
  emballages?: { nom: string; quantite: number }[];
  variantes?: { cle: string; selection: Record<string, string>; stock?: number; coutMoyen: number; prixVente?: number }[];
}

interface Props {
  produits: ProduitChoisissable[];
  lignes: LigneFlux[];
  onChange: (lignes: LigneFlux[]) => void;
  /** le coût se saisit pour un achat, il est hérité pour un transfert */
  coutEditable: boolean;
  /** affiche le stock disponible : utile pour un transfert, pas pour un achat */
  montrerStock: boolean;
  /** intitulé du champ de valeur */
  labelCout: string;
  /**
   * Ce que le site d'en face détient déjà de chaque produit — un transfert
   * seulement.
   *
   * Sans lui, on envoie à l'aveugle : un site qui a payé sa marchandise plus
   * cher voit son coût moyen bouger sans qu'on le lui ait annoncé, et une
   * marchandise arrivée sans prix se vendrait à zéro. Le prix se borne alors
   * sur SON coût après réception, pas sur le nôtre.
   */
  chezDestinataire?: Record<string, {
    stock: number; coutMoyen: number; prixVente: number;
  }>;
  /** Le nom de ce site, pour dire de qui l'on parle. */
  nomDestinataire?: string | null;
  /**
   * Mode vente : c'est le prix obtenu qui se saisit, pas le coût. Le coût
   * reste consultable — il vient du produit et sert à lire la marge — mais il
   * ne se négocie pas, et c'est au prix de vente que le total se calcule.
   */
  vente?: boolean;
  /**
   * Engagement futur — un devis, une commande à livrer plus tard. Le stock
   * reste affiché pour informer, mais le dépassement n'est plus signalé :
   * ce qu'on n'a pas aujourd'hui, on l'aura acheté d'ici la livraison.
   */
  futur?: boolean;
}

function libelleVariante(sel: Record<string, string>): string {
  return Object.values(sel).join(' / ');
}

/**
 * L'unité appartient au produit — le kilo, la pièce — et ne change jamais.
 * Un emballage dit seulement combien d'unités il contient : un carton de 25 kg
 * reste compté en kilos.
 */
function uniteLisible(p?: ProduitChoisissable, quantite = 1): string {
  const u = p?.unite?.trim() ? p.unite.toLowerCase() : 'unité';
  /* « kg » ne prend pas de s ; un mot plein en prend un au-delà de l'unité */
  const invariable = u.length <= 2 || u.endsWith('s');
  return quantite > 1 && !invariable ? `${u}s` : u;
}

/**
 * Une recherche, puis les marchandises retenues.
 *
 * Un catalogue affiché en permanence occupe la moitié de l'écran pour un
 * geste qui dure une seconde : on sait ce qu'on cherche, on le tape. La liste
 * ne s'ouvre que le temps de choisir, se parcourt aux flèches, et se referme
 * dès que la ligne est entrée — les mains ne quittent pas le clavier.
 *
 * Les lignes retenues prennent la forme du comptoir : l'emballage se choisit
 * en boutons plutôt qu'en liste déroulante, parce qu'un produit en porte deux
 * ou trois et qu'ouvrir un menu pour trois options coûte plus que de les
 * montrer.
 */
export default function SelecteurProduits({
  produits, lignes, onChange, coutEditable, montrerStock, labelCout,
  chezDestinataire, nomDestinataire,
  vente = false, futur = false,
}: Props) {
  const [recherche, setRecherche] = useState('');
  /* une seule ligne dépliée à la fois : la liste reste lisible */
  const [detailOuvert, setDetailOuvert] = useState<number | null>(null);
  /* entrée mise en avant dans la liste de recherche, pilotée au clavier */
  const [survol, setSurvol] = useState(0);
  /* Ce que le dossier rapporte et ce qu'il coûte, quand on veut le savoir. */
  const [marge, setMarge] = useState(false);

  /* Un détail ouvert se referme dès qu'on regarde ailleurs : c'est une
     vérification, pas un panneau qu'on garde. Le clic sur le ⓘ ou sur le
     bloc lui-même ne compte pas — l'un le bascule, l'autre est son contenu. */
  useEffect(() => {
    if (detailOuvert === null) return;
    function fermer(e: MouseEvent) {
      const cible = e.target as HTMLElement;
      if (cible.closest('[data-detail-produit]')) return;
      setDetailOuvert(null);
    }
    document.addEventListener('mousedown', fermer);
    return () => document.removeEventListener('mousedown', fermer);
  }, [detailOuvert]);

  const q = recherche.trim().toLowerCase();

  /**
   * La liste ne propose pas des produits mais des choses ajoutables : un
   * produit à trois variantes donne trois entrées. Choisir devient un seul
   * geste, sans étape intermédiaire pour préciser laquelle.
   */
  const suggestions = q
    ? produits
        .filter(p => p.designation.toLowerCase().includes(q)
          || (p.categorie ?? '').toLowerCase().includes(q)
          /* on cherche aussi dans les variantes : à l'écran elles font partie du nom */
          || (p.variantes ?? []).some(v => libelleVariante(v.selection).toLowerCase().includes(q)))
        .flatMap(p =>
          p.variantes && p.variantes.length > 0
            ? p.variantes
                /* si la recherche vise une variante précise, on ne montre qu'elle ;
                   si elle vise le produit, toutes ses variantes restent proposées */
                .filter(v => p.designation.toLowerCase().includes(q)
                  || (p.categorie ?? '').toLowerCase().includes(q)
                  || libelleVariante(v.selection).toLowerCase().includes(q))
                .map(v => ({
                  produit: p,
                  varianteCle: v.cle as string | null,
                  libelle: `${p.designation} · ${libelleVariante(v.selection)}`,
                  stock: v.stock ?? 0,
                }))
            : [{ produit: p, varianteCle: null as string | null, libelle: p.designation, stock: p.stock ?? 0 }]
        ).slice(0, 8)
    : [];

  /* une variante déjà retenue ne s'ajoute pas deux fois : on incrémente */
  function ajouter(p: ProduitChoisissable, varianteCle: string | null) {
    const v = varianteCle ? p.variantes?.find(x => x.cle === varianteCle) : undefined;
    const existante = lignes.findIndex(l =>
      l.produitId === p.id && (l.varianteCle ?? null) === varianteCle);

    if (existante >= 0) {
      onChange(lignes.map((l, i) => i === existante
        ? { ...l, quantiteDemandee: l.quantiteDemandee + 1 }
        : l));
      return;
    }

    onChange([...lignes, {
      produitId: p.id,
      designation: p.designation,
      varianteCle,
      varianteLibelle: v ? libelleVariante(v.selection) : null,
      quantiteDemandee: 1,
      /* l'unité suit le produit : elle doit voyager avec la ligne */
      unite: p.unite ?? null,
      /* Firestore refuse d'écrire un champ undefined : une ligne saisie à
         l'unité doit porter un emballage nul, pas un emballage absent. */
      emballage: null,
      valeurUnitaire: v ? v.coutMoyen : (p.coutMoyen ?? 0),
      /* une variante sans prix propre hérite de celui du produit */
      prixVente: (v?.prixVente ?? p.prixVente) || null,
    }]);
  }

  function majLigne(i: number, patch: Partial<LigneFlux>) {
    onChange(lignes.map((l, j) => j === i ? { ...l, ...patch } : l));
  }

  /**
   * Changer l'emballage d'une ligne.
   *
   * Le prix suit : un carton de 28 vaut 28 fois l'unité. Un emballage n'est
   * qu'un contenant, pas un article distinct — il ne porte donc pas de prix
   * propre, et celui-ci se déduit de la contenance.
   */
  function changerEmballage(i: number, nom: string | null, p?: ProduitChoisissable) {
    const l = lignes[i];
    if (!l) return;
    const avant = l.emballage
      ? (p?.emballages?.find(e => e.nom === l.emballage)?.quantite ?? 1)
      : 1;
    const apres = nom
      ? (p?.emballages?.find(e => e.nom === nom)?.quantite ?? 1)
      : 1;
    setDetailOuvert(null);

    /* 840 pièces font 30 cartons, pas 840 : la quantité se relit dans le
       nouveau contenant. */
    const variante = l.varianteCle
      ? p?.variantes?.find(v => v.cle === l.varianteCle)
      : undefined;
    const dispo = variante ? (variante.stock ?? 0) : (p?.stock ?? 0);
    const max = montrerStock && !futur
      ? Math.max(1, Math.floor(dispo / Math.max(1, apres)))
      : Infinity;

    majLigne(i, {
      emballage: nom,
      valeurUnitaire: (l.valeurUnitaire / avant) * apres,
      prixVente: l.prixVente != null ? (l.prixVente / avant) * apres : l.prixVente,
      quantiteDemandee: Math.max(1, Math.min(l.quantiteDemandee, max)),
    });
  }

  function ajouterSuggestion(n: number) {
    const s = suggestions[n];
    if (!s) return;
    ajouter(s.produit, s.varianteCle);
    /* on vide pour enchaîner la saisie suivante sans lever les mains du clavier */
    setRecherche('');
    setSurvol(0);
  }

  /* Une vente se totalise au prix obtenu ; un achat ou un transfert au coût. */
  const valeurLigne = (l: LigneFlux) =>
    l.quantiteDemandee * (vente ? (l.prixVente ?? 0) : l.valeurUnitaire);
  const total = lignes.reduce((s, l) => s + valeurLigne(l), 0);

  return (
    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">

      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-bold text-gray-900 dark:text-gray-100">Marchandise</p>
        <span className="text-xs text-gray-400">
          {lignes.length} ligne{lignes.length > 1 ? 's' : ''}
        </span>
      </div>

      {/* La recherche est la seule porte d'entrée : la liste s'ouvre à la
          frappe et se referme au choix. */}
      <ChampRecherche className="mb-4" placeholder="Rechercher un produit…"
        valeur={recherche}
        onChange={v => { setRecherche(v); setSurvol(0); }}
        onKeyDown={e => {
          if (suggestions.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSurvol(n => (n + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSurvol(n => (n - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            ajouterSuggestion(survol);
          } else if (e.key === 'Escape') {
            setRecherche('');
          }
        }}
        enfants={q ? (
          <div className="absolute z-20 left-0 right-0 top-full mt-1 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg overflow-hidden">
            {suggestions.length === 0 ? (
              <p className="px-3 py-2.5 text-xs text-gray-400">Aucun résultat.</p>
            ) : suggestions.map((sg, n) => (
              <button key={`${sg.produit.id}-${sg.varianteCle ?? ''}`} type="button"
                onMouseEnter={() => setSurvol(n)}
                onClick={() => ajouterSuggestion(n)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${n === survol
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                  : 'text-gray-700 dark:text-gray-300'}`}>
                <span className="truncate">{sg.libelle}</span>
                <span className="shrink-0 text-xs text-gray-400">
                  {montrerStock
                    ? `${sg.stock.toLocaleString('fr-FR')} ${uniteLisible(sg.produit, sg.stock)}`
                    : uniteLisible(sg.produit)}
                </span>
              </button>
            ))}
          </div>
        ) : undefined} />

      {lignes.length === 0 ? (
        <div className="py-12 text-center">
          <Package size={22} className="mx-auto text-gray-300 dark:text-gray-700" />
          <p className="text-xs text-gray-400 mt-2">
            {produits.length === 0
              ? 'Aucun produit dans ce site.'
              : 'Cherchez un produit pour commencer.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {lignes.map((l, i) => {
            const p = produits.find(x => x.id === l.produitId);
            const emballages = p?.emballages ?? [];
            const variante = l.varianteCle
              ? p?.variantes?.find(v => v.cle === l.varianteCle)
              : undefined;
            const dispo = variante ? (variante.stock ?? 0) : (p?.stock ?? 0);
            const contenance = l.emballage
              ? (emballages.find(e => e.nom === l.emballage)?.quantite ?? 1)
              : 1;

            const coutAvant = variante ? variante.coutMoyen : (p?.coutMoyen ?? 0);
            /* Le coût moyen ne bouge que lorsque de la marchandise entre : ce
               qu'on paie aujourd'hui se mêlle à ce qu'on avait payé avant.
               Une vente et un transfert sortant n'ajoutent rien — le coût
               reste ce qu'il était, et montrer un « avant » là où rien ne
               change n'apprend rien. */
            const entree = coutEditable && !vente;
            const coutApres = entree
              ? coutMoyenApresEntree(
                  dispo, coutAvant,
                  enUnitesBase(l.quantiteDemandee, l.emballage, emballages),
                  /* le coût se saisit dans l'emballage : le stock, lui, se
                     tient à l'unité */
                  l.valeurUnitaire / Math.max(1, contenance),
                )
              : coutAvant;
            /* Ce que le site d'en face en a déjà, et ce que la marchandise
               lui coûtera une fois arrivée : son stock garde son poids, ce
               qui arrive pèse le nôtre. */
            const chez = chezDestinataire?.[l.produitId] ?? null;
            const coutChezLui = chez
              ? coutMoyenApresEntree(
                  chez.stock, chez.coutMoyen,
                  enUnitesBase(l.quantiteDemandee, l.emballage, emballages),
                  l.valeurUnitaire / Math.max(1, contenance))
              : null;

            /* Vendre sous son coût, c'est perdre à chaque unité. Les deux
               se disent dans l'emballage retenu, donc ils se comparent
               directement. En transfert, c'est le coût du receveur qui
               borne : c'est lui qui vendra.

               Le champ remonte au plancher plutôt que d'interdire l'envoi :
               bloquer laissait l'utilisateur devant un bouton éteint sans
               lui dire quoi taper. */
            const coutQuiBorne = coutChezLui != null
              ? Math.round(coutChezLui * contenance)
              : l.valeurUnitaire;
            const sousLeCout = (l.prixVente ?? 0) > 0
              && l.prixVente! < coutQuiBorne;
            /* Ce qu'on n'a pas ne se transfère pas ; une commande, si — on se
               réapprovisionne avant de livrer. Le plafond ne vaut donc que là
               où la marchandise part d'ici aujourd'hui. */
            const borne = montrerStock && !futur;
            const maxLigne = borne
              ? Math.floor(dispo / Math.max(1, contenance))
              : Infinity;
            const auPlafond = borne && l.quantiteDemandee >= maxLigne;

            return (
              <div key={`${l.produitId}-${l.varianteCle ?? ''}-${i}`}
                className="p-3 rounded-xl border border-gray-100 dark:border-gray-800">

                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-bold leading-tight flex items-start gap-1">
                    {/* Le stock, les emballages et le coût moyen ne se lisent
                        qu'au moment de fixer une quantité ou un prix. */}
                    <button onClick={() => setDetailOuvert(detailOuvert === i ? null : i)}
                      data-detail-produit title="Stock, coût et emballages"
                      className={`shrink-0 mt-px transition-colors ${detailOuvert === i
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-gray-300 hover:text-indigo-500'}`}>
                      <Info size={12} />
                    </button>
                    <span>
                      {l.designation}{l.varianteLibelle ? ` · ${l.varianteLibelle}` : ''}
                    </span>
                  </p>
                  <button onClick={() => onChange(lignes.filter((_, j) => j !== i))}
                    className="text-gray-300 hover:text-red-500 shrink-0">
                    <Trash2 size={13} />
                  </button>
                </div>

                {detailOuvert === i && (
                  <div data-detail-produit
                    className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 px-2.5 py-2 rounded-lg bg-gray-50 dark:bg-gray-800 text-xs">
                    <span className="text-gray-400">
                      {/* Le stock se lit dans le contenant qu'on manipule :
                          « 748 pièces » ne se vérifie pas quand on compte des
                          cartons. */}
                      Stock <span className={`font-bold ${dispo > 0 ? 'text-gray-700 dark:text-gray-200' : 'text-red-400'}`}>
                        {Math.floor(dispo / Math.max(1, contenance)).toLocaleString('fr-FR')}
                      </span>{' '}
                      {l.emballage
                        ? `${l.emballage.toLowerCase()}${Math.floor(dispo / Math.max(1, contenance)) > 1 ? 's' : ''}`
                        : uniteLisible(p, dispo)}
                    </span>
                    {/* Tout se dit dans le contenant retenu : le stock, le
                        prix, le coût. Mélanger les unités dans un même bandeau
                        obligerait à convertir de tête.
                        Le « avant » n'apparaît qu'en achat, où ce qu'on saisit
                        déplace vraiment le coût moyen du produit. */}
                    <span className="text-gray-400">
                      Coût moyen <span className={`font-bold ${coutApres !== coutAvant
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-gray-700 dark:text-gray-200'}`}>
                        {formatMontant(coutApres * contenance)}
                      </span>
                      {coutApres !== coutAvant && (
                        <span className="ml-1 text-gray-400">
                          (avant {formatMontant(coutAvant * contenance)})
                        </span>
                      )}
                    </span>
                    {p?.prixVente != null && (
                      <span className="text-gray-400">
                        Prix produit <span className="font-bold text-gray-700 dark:text-gray-200">
                          {formatMontant(p.prixVente * contenance)}
                        </span>
                      </span>
                    )}

                    {/* Ce que le site d'en face en a déjà. Sa marchandise
                        garde son poids dans le calcul : envoyer 1 pièce à
                        2 500 chez qui en a 50 à 2 000 ne fait pas passer son
                        coût à 2 500. */}
                    {chez && (
                      <>
                        <span className="w-full border-t border-gray-200 pt-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-400 dark:border-gray-700">
                          Chez {nomDestinataire ?? 'la destination'}
                        </span>
                        <span className="text-gray-400">
                          Stock <span className={`font-bold ${chez.stock > 0
                            ? 'text-gray-700 dark:text-gray-200' : 'text-gray-400'}`}>
                            {Math.floor(chez.stock / Math.max(1, contenance)).toLocaleString('fr-FR')}
                          </span>{' '}
                          {l.emballage
                            ? `${l.emballage.toLowerCase()}${Math.floor(chez.stock / Math.max(1, contenance)) > 1 ? 's' : ''}`
                            : uniteLisible(p, chez.stock)}
                        </span>
                        <span className="text-gray-400">
                          Son coût <span className={`font-bold ${
                            coutChezLui != null && coutChezLui !== chez.coutMoyen
                              ? 'text-indigo-600 dark:text-indigo-400'
                              : 'text-gray-700 dark:text-gray-200'}`}>
                            {formatMontant((coutChezLui ?? chez.coutMoyen) * contenance)}
                          </span>
                          {chez.stock > 0 && coutChezLui != null && coutChezLui !== chez.coutMoyen && (
                            <span className="ml-1 text-gray-400">
                              (avant {formatMontant(chez.coutMoyen * contenance)})
                            </span>
                          )}
                        </span>
                        {chez.prixVente > 0 && (
                          <span className="text-gray-400">
                            Son prix <span className="font-bold text-gray-700 dark:text-gray-200">
                              {formatMontant(chez.prixVente * contenance)}
                            </span>
                          </span>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* L'emballage qu'on retient. En changer refait le coût et le
                    prix : ils suivent la contenance. */}
                {emballages.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    <button onClick={() => changerEmballage(i, null, p)}
                      className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors ${!l.emballage
                        ? 'bg-indigo-600 text-white'
                        : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
                      {uniteLisible(p)}
                    </button>
                    {emballages.map(e => (
                      <button key={e.nom} onClick={() => changerEmballage(i, e.nom, p)}
                        className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors ${l.emballage === e.nom
                          ? 'bg-indigo-600 text-white'
                          : 'border border-gray-200 dark:border-gray-700 text-gray-500 hover:border-indigo-400'}`}>
                        {e.nom.toLowerCase()}×{e.quantite}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 mt-2">
                  {/* La quantité n'est jamais bornée sur un engagement futur :
                      on commande ce qu'on doit livrer, et on se réapprovisionne
                      pour l'honorer. Le dépassement est signalé, pas interdit. */}
                  <div className="flex items-center gap-1">
                    <button onClick={() => majLigne(i, {
                      quantiteDemandee: Math.max(1, l.quantiteDemandee - 1) })}
                      className="p-1 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800">
                      <Minus size={11} />
                    </button>
                    <ChampNombre valeur={l.quantiteDemandee} min={1}
                      onChange={n => majLigne(i, {
                        quantiteDemandee: Math.max(1, Math.min(n, maxLigne)) })}
                      className={`w-24 px-2 py-1 rounded-lg border bg-gray-50 dark:bg-gray-800 text-xs text-center focus:outline-none focus:ring-2 focus:ring-indigo-500 ${auPlafond
                        ? 'border-red-300 dark:border-red-800 text-red-600 dark:text-red-400'
                        : 'border-gray-200 dark:border-gray-700'}`} />
                    <button onClick={() => majLigne(i, {
                      quantiteDemandee: Math.min(l.quantiteDemandee + 1, maxLigne) })}
                      disabled={l.quantiteDemandee >= maxLigne}
                      className="p-1 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed">
                      <Plus size={11} />
                    </button>
                  </div>

                  {/* Le coût ne se saisit jamais sur une vente : il vient du
                      stock, et c'est lui qui fige la marge. */}
                  {coutEditable && !vente && (
                    <label className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-400">{labelCout}</span>
                      <ChampNombre valeur={l.valeurUnitaire}
                        onChange={n => majLigne(i, { valeurUnitaire: n })}
                        className="w-24 px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-xs text-center focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </label>
                  )}

                  {/* En transfert, le prix qu'on pose est celui que le
                      receveur pratiquera : il ne peut pas descendre sous ce
                      que la marchandise lui aura coûté, mais rien ne le
                      borne vers le haut — sa marge lui appartient. */}
                  {(coutEditable || vente || chezDestinataire) && (
                    <label className="flex items-center gap-1.5">
                      <span className="text-xs text-gray-400">
                        {chezDestinataire ? 'Prix proposé' : 'Prix'}
                      </span>
                      {/* `min` ramène au plancher quand on quitte le champ :
                          on garde la liberté de taper, on ne garde pas une
                          valeur qui ferait vendre à perte. */}
                      <ChampNombre valeur={l.prixVente ?? 0}
                        min={chezDestinataire ? coutQuiBorne : 0}
                        onChange={n => majLigne(i, {
                          prixVente: chezDestinataire
                            ? Math.max(n, coutQuiBorne)
                            : (n || null) })}
                        className={`w-24 px-2 py-1 rounded-lg border text-xs text-center focus:outline-none focus:ring-2 ${sousLeCout
                          ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 focus:ring-red-500'
                          : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 focus:ring-indigo-500'}`} />
                    </label>
                  )}

                  <span className="ml-auto text-xs font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                    {formatMontant(valeurLigne(l))}
                  </span>
                </div>

                {auPlafond && (
                  <p className="text-xs text-orange-500 mt-1.5">
                    Tout le stock : {dispo.toLocaleString('fr-FR')} {uniteLisible(p, dispo)}.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex justify-between items-baseline pt-3 mt-3 border-t border-gray-100 dark:border-gray-800">
        <span className="flex items-center gap-1.5 text-xs text-gray-400">
          Total
          {/* Ce que le dossier dégage ne se lit pas en saisissant : on l'ouvre
              quand on doute d'un prix, pas à chaque ligne. Un transfert n'a
              pas de marge — on ne se vend rien à soi-même. */}
          {lignes.length > 0 && (coutEditable || vente) && (
            <button type="button" onClick={() => setMarge(true)} title="Marge du dossier"
              className="text-gray-300 hover:text-indigo-500 transition-colors">
              <BarChart3 size={13} />
            </button>
          )}
        </span>
        <span className="text-base font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">
          {formatMontant(total)}
        </span>
      </div>

      {marge && (
        <ModalMargeRecu onFermer={() => setMarge(false)} titre="Marge du dossier"
          lignes={lignes.map((l, i) => {
            const p = produits.find(x => x.id === l.produitId);
            return {
              cle: `${l.produitId}-${l.varianteCle ?? ''}-${i}`,
              designation: l.designation,
              varianteLibelle: l.varianteLibelle,
              emballage: l.emballage,
              quantiteDemandee: l.quantiteDemandee,
              /* Le coût et le prix portent déjà sur l'emballage retenu : ils
                 suivent la contenance depuis le choix du contenant. */
              cout: l.valeurUnitaire,
              prix: l.prixVente ?? 0,
            };
          })} />
      )}
    </div>
  );
}
