'use client';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { X, Loader2, Check, Undo2 } from 'lucide-react';
import { ChampNombre, ChampRecherche } from '@/components/Champs';
import { formatMontant } from '@/lib/format';
import { auteurCourant } from '@/lib/auteur';
import { enregistrerRetour, partageRetour, quantiteDejaRendue } from '@/lib/retours';
import { soldeTiers, type RoleTiers } from '@/lib/soldes';
import { useAuth } from '@/lib/auth-context';

/** Une ligne déjà sortie ou entrée, sur laquelle un retour peut porter. */
interface LigneRendable {
  id: string;
  produit: string;
  unite: string;
  reference: string | null;
  date: string;
  quantite: number;
  /** ce qui reste rendable après les retours déjà passés */
  rendable: number;
  prix: number;
  achatId: string | null;
  venteId: string | null;
}

/**
 * Enregistrer un retour de marchandise.
 *
 * On part de ce qui est sorti, jamais d'une saisie libre : un retour porte
 * sur une ligne précise, et ne peut pas dépasser ce qu'elle a fait circuler.
 * Le prix vient de l'opération d'origine — rendre une pièce vendue 6 500 vaut
 * 6 500, quel que soit le prix du jour.
 */
export default function ModalRetour({
  siteId, userId, role, partenaireId, partenaireNom, onFermer, onRetour,
}: {
  siteId: string;
  userId: string;
  role: RoleTiers;
  partenaireId: string;
  partenaireNom?: string | null;
  onFermer: () => void;
  onRetour: () => void;
}) {
  /* L'admin de l'activité n'a pas de rôle de site : son identifiant sert
     à le reconnaître quand la caisse cherche qui agit. */
  const { activite } = useAuth();
  const [lignes, setLignes] = useState<LigneRendable[]>([]);
  const [quantites, setQuantites] = useState<Record<string, number>>({});
  const [recherche, setRecherche] = useState('');
  const [resteDu, setResteDu] = useState(0);
  const [chargement, setChargement] = useState(true);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    (async () => {
      const [movSnap, solde] = await Promise.all([
        getDocs(query(
          collection(db, 'mouvements'),
          where('siteId', '==', siteId),
          where('partenaireId', '==', partenaireId))),
        soldeTiers(siteId, partenaireId, role),
      ]);
      setResteDu(solde.reste);

      /* Les lignes écrites avant que `role` n'existe n'en portent pas : leur
         sens le dit tout de même — ce qui est entré vient d'un fournisseur,
         ce qui est sorti est parti chez un client. Sans cela, tout
         l'historique antérieur serait invisible ici. */
      const roleDe = (m: any): RoleTiers =>
        m.role ?? (m.sens === 'entree' ? 'fournisseur' : 'client');

      const brutes = movSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(m => roleDe(m) === role && m.motif !== 'retour');

      /* Ce qui reste rendable tient compte des retours déjà passés : sans
         cela, on pourrait rendre deux fois la même marchandise. */
      const avec = await Promise.all(brutes.map(async m => {
        const deja = await quantiteDejaRendue(m.id);
        return {
          id: m.id,
          produit: m.produit ?? '—',
          unite: m.unite ?? '',
          reference: m.reference ?? null,
          date: m.date ?? '',
          quantite: m.quantite ?? 0,
          rendable: (m.quantite ?? 0) - deja,
          prix: role === 'client' ? (m.prixVente ?? 0) : (m.cout ?? m.valeurUnitaire ?? 0),
          achatId: m.achatId ?? null,
          venteId: m.venteId ?? null,
        } as LigneRendable;
      }));

      setLignes(avec.filter(l => l.rendable > 0)
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')));
      setChargement(false);
    })().catch(e => { setErreur(e?.message ?? 'Chargement impossible.'); setChargement(false); });
  }, [siteId, partenaireId, role]);

  const visibles = lignes.filter(l => !recherche.trim()
    || l.produit.toLowerCase().includes(recherche.trim().toLowerCase())
    || (l.reference ?? '').toLowerCase().includes(recherche.trim().toLowerCase()));

  const choisies = lignes
    .map(l => ({ l, q: quantites[l.id] ?? 0 }))
    .filter(x => x.q > 0);
  const valeur = choisies.reduce((n, x) => n + x.q * x.l.prix, 0);
  const { deduitDuDu, rembourse } = partageRetour(valeur, resteDu);

  async function enregistrer() {
    if (choisies.length === 0) return;
    setEnCours(true); setErreur('');
    try {
      /* Un seul dossier concerné : le retour s'y rattache. Plusieurs, et il
         reste un acte à part, rattaché à ses lignes. */
      const dossiers = new Set(choisies.map(x => x.l.achatId ?? x.l.venteId ?? ''));
      const seul = dossiers.size === 1 ? [...dossiers][0] : null;

      await enregistrerRetour({
        siteId, userId, partenaireId, partenaireNom, role,
        lignes: choisies.map(x => ({ mouvementId: x.l.id, quantite: x.q })),
        date: new Date().toISOString().split('T')[0],
        resteDu,
        achatId: role === 'fournisseur' ? seul : null,
        venteId: role === 'client' ? seul : null,
        reference: choisies[0]?.l.reference ?? null,
        par: userId,
        adminUid: activite?.adminUid ?? null,
        ...(await auteurCourant(siteId, userId)),
      });
      onRetour();
      onFermer();
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="flex h-[560px] max-h-[88vh] w-full max-w-md flex-col rounded-2xl bg-white dark:bg-gray-900 p-5 shadow-xl">
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold text-gray-900 dark:text-gray-100">
            <Undo2 size={16} className="text-orange-500" />
            Retour — {partenaireNom ?? (role === 'fournisseur' ? 'Fournisseur' : 'Client')}
          </h2>
          <button onClick={onFermer} className="p-1 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {chargement ? (
            <div className="flex justify-center py-10">
              <Loader2 size={18} className="animate-spin text-indigo-500" />
            </div>
          ) : lignes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 px-3 py-10 text-center">
              <p className="text-sm font-medium text-gray-500">Rien à retourner</p>
              <p className="mt-0.5 text-xs text-gray-400">
                Aucune marchandise n&apos;a circulé avec ce compte, ou tout a déjà été rendu.
              </p>
            </div>
          ) : (
            <>
              <ChampRecherche
                placeholder="Rechercher un produit ou une référence…"
                valeur={recherche} onChange={setRecherche}
                className="w-full mb-2"
              />
              <p className="mb-2 text-xs font-medium text-gray-500">
                {visibles.length} ligne{visibles.length > 1 ? 's' : ''} rendable{visibles.length > 1 ? 's' : ''}
              </p>

              <div className="overflow-hidden rounded-xl border border-gray-100 dark:border-gray-800 divide-y divide-gray-50 dark:divide-gray-800">
                {visibles.map(l => (
                  <div key={l.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {l.produit}
                      </p>
                      <p className="text-xs text-gray-400">
                        {l.reference ?? '—'} · {l.date ? new Date(l.date).toLocaleDateString('fr-FR') : '—'}
                        {' · '}{formatMontant(l.prix)} / {l.unite || 'unité'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* On ne rend jamais plus qu'il n'est sorti : le champ
                          plafonne de lui-même. */}
                      <ChampNombre
                        valeur={quantites[l.id] ?? 0}
                        onChange={n => setQuantites(p => ({ ...p, [l.id]: n }))}
                        max={l.rendable}
                        className="w-20 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-right text-sm text-gray-900 dark:text-gray-100"
                      />
                      <p className="mt-0.5 text-[10px] text-gray-400">sur {l.rendable}</p>
                    </div>
                  </div>
                ))}
              </div>

              {valeur > 0 && (
                <div className="mt-3 overflow-hidden rounded-xl border border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-900/20">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-xs font-bold uppercase text-orange-700 dark:text-orange-400">
                      Valeur du retour
                    </span>
                    <span className="text-sm font-bold text-orange-700 dark:text-orange-400">
                      {formatMontant(valeur)}
                    </span>
                  </div>
                  {/* Un retour ne rembourse que ce qui avait été payé : tant
                      que la marchandise n'était pas réglée, la rendre éteint
                      simplement la dette. */}
                  <div className="divide-y divide-orange-100 dark:divide-orange-900/50 border-t border-orange-100 dark:border-orange-900/50">
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-gray-600 dark:text-gray-300">Cesse d&apos;être dû</span>
                      <span className="font-bold text-gray-700 dark:text-gray-200">{formatMontant(deduitDuDu)}</span>
                    </div>
                    <div className="flex items-center justify-between px-3 py-1.5 text-xs">
                      <span className="text-gray-600 dark:text-gray-300">
                        {role === 'client' ? 'À rembourser' : 'À recevoir'}
                      </span>
                      <span className={`font-bold ${rembourse > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                        {formatMontant(rembourse)}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {erreur && <p className="mt-3 text-xs text-red-500">{erreur}</p>}
        </div>

        {choisies.length > 0 && (
          <div className="flex shrink-0 gap-3 pt-4">
            <button onClick={onFermer}
              className="flex-1 rounded-xl border border-gray-200 dark:border-gray-700 py-2.5 text-sm font-medium text-gray-500">
              Annuler
            </button>
            <button onClick={enregistrer} disabled={enCours}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-orange-600 py-2.5 text-sm font-bold text-white transition-colors hover:bg-orange-700 disabled:opacity-40">
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Enregistrer le retour
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
