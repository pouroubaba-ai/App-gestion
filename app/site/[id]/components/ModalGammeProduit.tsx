'use client';
import { useState } from 'react';
import { X, Plus, Check, Loader2, Trash2 } from 'lucide-react';
import { ChampNombre } from '@/components/Champs';
import { nomDejaPris, type Emballage } from '@/lib/mouvements';
import { cleVariante, type Caracteristique } from '@/lib/produit-forme';

/**
 * Créer une gamme sans quitter le bon d'achat.
 *
 * Le fournisseur n'apporte pas « une ampoule », il apporte les 15 W, les
 * 25 W et les 40 W. Les créer une par une obligerait à répéter la même
 * description trois fois, et à inventer trois noms là où il n'y a qu'un
 * produit et trois puissances.
 *
 * On décrit donc ce qui varie — une caractéristique et ses choix — et les
 * déclinaisons en découlent. Elles entrent toutes dans le bon : on vient
 * de les décrire, c'est qu'on les reçoit. Ce qui ne vient pas se retire
 * d'une ligne, et se retrouve par la recherche puisque le produit existe.
 *
 * Volontairement plus étroit que le formulaire de l'inventaire : ici on
 * saisit un achat, pas une fiche produit. Le code-barres, le seuil
 * d'alerte et les stocks de départ se posent plus tard, sur la fiche.
 */
export default function ModalGammeProduit({
  designationInitiale, onAnnuler, onCreer,
}: {
  designationInitiale: string;
  onAnnuler: () => void;
  onCreer: (saisie: {
    designation: string;
    unite: string;
    categorie: string | null;
    emballages: Emballage[];
    caracteristiques: Caracteristique[];
    declinaisons: { selection: Record<string, string> }[];
    cout: number;
    prix: number;
  }) => Promise<void>;
}) {
  const [designation, setDesignation] = useState(designationInitiale);
  const [unite, setUnite] = useState('pièce');
  const [categorie, setCategorie] = useState('');
  const [cout, setCout] = useState(0);
  const [prix, setPrix] = useState(0);

  /* Une seule caractéristique, et c'est voulu.
   *
   * Croiser deux axes — couleur et taille — donne douze déclinaisons
   * qu'il faudrait toutes décrire, au milieu d'une saisie d'achat. Ce
   * cas-là mérite la fiche produit, qui a la place pour lui. Ici on
   * traite le cas courant : une gamme, un axe. */
  const [nomCarac, setNomCarac] = useState('');
  const [choix, setChoix] = useState<string[]>([]);
  const [saisieChoix, setSaisieChoix] = useState('');

  const [emballages, setEmballages] = useState<Emballage[]>([]);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  const caracs: Caracteristique[] = nomCarac.trim() && choix.length > 0
    ? [{ nom: nomCarac.trim(), valeurs: choix }]
    : [];

  /* Les clés telles qu'elles existeront : un conditionnement peut s'y
     rattacher avant même que le produit soit écrit. */
  const cles = choix.map(v => cleVariante({ [nomCarac.trim()]: v }, caracs));

  function ajouterChoix() {
    const v = saisieChoix.trim();
    if (!v || choix.some(x => x.toLowerCase() === v.toLowerCase())) return;
    setChoix(c => [...c, v]);
    setSaisieChoix('');
    setErreur('');
  }

  async function valider() {
    const nom = designation.trim();
    if (!nom) { setErreur('Il faut une désignation.'); return; }
    if (nomCarac.trim() && choix.length === 0) {
      setErreur('Ajoute au moins un choix, ou retire la caractéristique.');
      return;
    }

    const embValides = emballages
      .filter(e => e.nom.trim() && e.quantite > 1)
      .map(e => ((e.variantes?.length ?? 0) > 0
        ? { nom: e.nom.trim(), quantite: e.quantite, variantes: e.variantes }
        : { nom: e.nom.trim(), quantite: e.quantite }));

    if (emballages.length !== embValides.length) {
      setErreur('Chaque conditionnement doit avoir un nom et au moins 2 unités.');
      return;
    }

    /* Deux conditionnements de même nom ne peuvent pas se rencontrer sur
       une même déclinaison : le vendeur ne saurait pas lequel il tient.
       Ils le peuvent s'ils ne se croisent jamais. */
    for (let i = 0; i < embValides.length; i++) {
      const e = embValides[i];
      if (nomDejaPris(embValides.slice(0, i), e.nom, (e as any).variantes)) {
        setErreur(`« ${e.nom} » est déjà pris pour ces déclinaisons.`);
        return;
      }
    }

    setErreur('');
    setEnCours(true);
    try {
      await onCreer({
        designation: nom,
        unite: unite.trim() || 'pièce',
        categorie: categorie.trim() || null,
        emballages: embValides,
        caracteristiques: caracs,
        /* Sans caractéristique, une seule déclinaison : le produit nu. */
        declinaisons: caracs.length > 0
          ? choix.map(v => ({ selection: { [nomCarac.trim()]: v } }))
          : [],
        cout, prix,
      });
    } catch (e: any) {
      setErreur(e?.message ?? 'Le produit n’a pas pu être créé.');
      setEnCours(false);
    }
  }

  const champ = 'w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 '
    + 'text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 '
    + 'dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
              Nouveau produit
            </h2>
            <p className="mt-0.5 text-[11px] text-gray-400">
              Décris ce qui varie : les déclinaisons entreront toutes dans le bon.
            </p>
          </div>
          <button onClick={onAnnuler}
            className="p-1 text-gray-400 transition-colors hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-bold uppercase text-gray-400">
                Désignation
              </label>
              <input type="text" value={designation} className={champ}
                onChange={e => { setDesignation(e.target.value); setErreur(''); }}
                placeholder="Ex. Ampoule Ingelec" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase text-gray-400">
                Unité
              </label>
              <input type="text" value={unite} className={champ}
                onChange={e => setUnite(e.target.value)} placeholder="pièce" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase text-gray-400">
                Catégorie
              </label>
              <input type="text" value={categorie} className={champ}
                onChange={e => setCategorie(e.target.value)} placeholder="Facultatif" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase text-gray-400">
                Coût d&apos;achat
              </label>
              {/* Le coût se corrigera de toute façon sur la ligne du bon :
                  ici il ne sert qu'à ne pas partir de zéro. */}
              <ChampNombre valeur={cout} onChange={setCout} className={champ} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold uppercase text-gray-400">
                Prix de vente
              </label>
              <ChampNombre valeur={prix} onChange={setPrix} className={champ} />
            </div>
          </div>

          {/* Ce qui fait la gamme. Sans caractéristique, le produit reste
              simple — c'est le cas d'une référence unique. */}
          <div className="rounded-xl border border-gray-100 p-3 dark:border-gray-800">
            <p className="mb-2 text-xs font-bold uppercase text-gray-400">
              Ce qui varie <span className="font-medium normal-case">(facultatif)</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <input type="text" value={nomCarac}
                onChange={e => setNomCarac(e.target.value)}
                placeholder="Ex. Puissance"
                className={`${champ} min-w-[140px] flex-1`} />
              <div className="flex min-w-[180px] flex-1 gap-2">
                <input type="text" value={saisieChoix}
                  onChange={e => setSaisieChoix(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); ajouterChoix(); } }}
                  disabled={!nomCarac.trim()}
                  placeholder={nomCarac.trim() ? 'Ex. 15W' : 'Nomme d’abord'}
                  className={`${champ} flex-1 disabled:opacity-50`} />
                <button type="button" onClick={ajouterChoix}
                  disabled={!nomCarac.trim() || !saisieChoix.trim()}
                  className="shrink-0 rounded-xl bg-indigo-600 px-3 py-2.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
                  Ajouter
                </button>
              </div>
            </div>
            {choix.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {choix.map(v => (
                  <span key={v}
                    className="flex items-center gap-1 rounded-lg bg-indigo-50 px-2 py-1 text-[11px] font-bold text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                    {v}
                    <button type="button" onClick={() => setChoix(c => c.filter(x => x !== v))}
                      className="hover:opacity-60">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-gray-400">
              {choix.length > 0
                ? `${choix.length} déclinaison${choix.length > 1 ? 's' : ''} entreront dans le bon.`
                : 'Sans cela, une seule référence sera créée.'}
            </p>
          </div>

          {/* Les conditionnements, et à qui ils s'appliquent. Un carton de
              15 W n'en contient pas le même nombre qu'un carton de 40 W. */}
          <div className="rounded-xl border border-gray-100 p-3 dark:border-gray-800">
            <p className="mb-2 text-xs font-bold uppercase text-gray-400">
              Conditionnements <span className="font-medium normal-case">(facultatif)</span>
            </p>
            {emballages.map((e, i) => (
              <div key={i} className="mb-2">
                <div className="flex gap-2">
                  <input type="text" value={e.nom}
                    onChange={ev => setEmballages(p => p.map((x, j) =>
                      j === i ? { ...x, nom: ev.target.value } : x))}
                    placeholder="Ex. Carton"
                    className={`${champ} min-w-0 flex-1`} />
                  <div className="w-28 shrink-0">
                    <ChampNombre valeur={e.quantite} min={0}
                      onChange={v => setEmballages(p => p.map((x, j) =>
                        j === i ? { ...x, quantite: v } : x))}
                      className={champ} />
                  </div>
                  <button type="button"
                    onClick={() => setEmballages(p => p.filter((_, j) => j !== i))}
                    className="shrink-0 rounded-lg p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20">
                    <Trash2 size={13} />
                  </button>
                </div>
                {cles.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button type="button"
                      onClick={() => setEmballages(p => p.map((x, j) =>
                        j === i ? { ...x, variantes: [] } : x))}
                      className={`rounded-lg px-2 py-0.5 text-[11px] font-bold transition-colors ${
                        (e.variantes?.length ?? 0) === 0
                          ? 'bg-indigo-600 text-white'
                          : 'border border-gray-200 text-gray-500 dark:border-gray-700'}`}>
                      Toutes
                    </button>
                    {cles.map(cle => {
                      const prise = (e.variantes ?? []).includes(cle);
                      return (
                        <button key={cle} type="button"
                          onClick={() => setEmballages(p => p.map((x, j) => {
                            if (j !== i) return x;
                            const l = x.variantes ?? [];
                            return {
                              ...x,
                              variantes: prise ? l.filter(y => y !== cle) : [...l, cle],
                            };
                          }))}
                          className={`rounded-lg px-2 py-0.5 text-[11px] font-bold transition-colors ${
                            prise
                              ? 'bg-indigo-600 text-white'
                              : 'border border-gray-200 text-gray-500 dark:border-gray-700'}`}>
                          {cle}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            <button type="button"
              onClick={() => setEmballages(p => [...p, { nom: '', quantite: 0 }])}
              className="flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700">
              <Plus size={12} /> Ajouter un conditionnement
            </button>
          </div>
        </div>

        {erreur && <p className="mt-3 shrink-0 text-xs text-red-500">{erreur}</p>}

        <div className="mt-4 flex shrink-0 gap-3">
          <button type="button" onClick={onAnnuler} disabled={enCours}
            className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-500 transition-colors hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800">
            Annuler
          </button>
          <button type="button" onClick={valider}
            disabled={enCours || !designation.trim()}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:opacity-40">
            {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {choix.length > 1 ? `Créer les ${choix.length}` : 'Créer'}
          </button>
        </div>
      </div>
    </div>
  );
}
