'use client';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { Loader2, Check, Ship } from 'lucide-react';
import { produitsDuSite } from '@/lib/produits-site';
import { auteurCourant } from '@/lib/auteur';
import SelecteurProduits, { ProduitChoisissable } from '@/app/site/[id]/components/SelecteurProduits';
import { SelectCherchable } from '@/components/Champs';
import { type LigneFlux } from '@/lib/flux-marchandise';
import { creerImportation } from '@/lib/importations';

interface Bref { id: string; nom: string }

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

/**
 * Ouvrir une importation.
 *
 * C'est l'écran d'un achat, à deux choses près. Le site n'est pas donné
 * par l'adresse mais choisi : le dossier se mène depuis la maison, et
 * l'on désigne où la marchandise ira. Et l'origine se note — savoir
 * qu'un conteneur vient de Guangzhou plutôt que de Dubaï change ce
 * qu'on attend du délai.
 *
 * Aucun versement ici : à l'ouverture, le fournisseur n'a rien confirmé.
 * L'argent se pose sur la fiche, au fil du voyage.
 */
export default function NouvelleImportationPage() {
  const { user, activite } = useAuth();
  const router = useRouter();

  const [sites, setSites] = useState<Bref[]>([]);
  const [fournisseurs, setFournisseurs] = useState<Bref[]>([]);
  const [produits, setProduits] = useState<ProduitChoisissable[]>([]);
  const [loading, setLoading] = useState(true);

  const [siteId, setSiteId] = useState('');
  const [fournisseurId, setFournisseurId] = useState('');
  const [origine, setOrigine] = useState('');
  const [lignes, setLignes] = useState<LigneFlux[]>([]);
  const [note, setNote] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  /* Les sites de la maison : c'est parmi eux qu'on désigne la
     destination. */
  useEffect(() => {
    if (!activite) { setLoading(false); return; }
    (async () => {
      const snap = await getDocs(query(
        collection(db, 'sites'), where('activiteId', '==', activite.id)));
      const l = snap.docs.map(d => ({ id: d.id, nom: (d.data() as any).nom as string }));
      setSites(l);
      /* Un seul site : le choix n'en est pas un. */
      if (l.length === 1) setSiteId(l[0].id);
    })().catch(() => {}).finally(() => setLoading(false));
  }, [activite]);

  /* Le catalogue et les fournisseurs suivent le site choisi : c'est son
     rayon qu'on garnit, et son carnet qu'on consulte. */
  useEffect(() => {
    if (!siteId) { setProduits([]); setFournisseurs([]); return; }
    (async () => {
      const [partSnap, prods] = await Promise.all([
        /* Le site, pas le compte : `userId` dit qui a inscrit le tiers,
           pas à qui il appartient. */
        getDocs(query(collection(db, 'partenaires'),
          where('siteId', '==', siteId))),
        produitsDuSite(siteId),
      ]);
      /* Un import est un achat : ce sont les mêmes fournisseurs. Un
         partenaire peut cumuler les deux rôles — seul le côté
         fournisseur compte ici. */
      setFournisseurs(partSnap.docs
        .filter(d => d.data().rolesFournisseur)
        .map(d => ({ id: d.id, nom: d.data().nom as string })));
      setProduits(prods as ProduitChoisissable[]);
      /* Changer de site change le catalogue : garder les lignes
         laisserait commander des références que ce rayon ne tient
         pas. */
      setLignes([]);
      setFournisseurId('');
    })().catch(() => {});
  }, [siteId]);

  /* Une ligne à zéro n'est pas ignorée mais bloquante : la laisser
     passer ferait disparaître un produit qu'on croit avoir commandé. */
  const lignesCompletes = lignes.length > 0
    && lignes.every(l => l.produitId && l.quantiteDemandee > 0);
  const pret = !!siteId && !!fournisseurId && lignesCompletes;

  const total = lignes.reduce(
    (s, l) => s + l.quantiteDemandee * (l.valeurUnitaire ?? 0), 0);

  async function enregistrer() {
    if (!pret || !user || !activite) return;
    setEnCours(true); setErreur('');
    try {
      const f = fournisseurs.find(x => x.id === fournisseurId);
      const s = sites.find(x => x.id === siteId);
      const auteur = await auteurCourant(siteId, user.uid);
      const id = await creerImportation({
        activiteId: activite.id,
        siteId,
        siteNom: s?.nom ?? null,
        fournisseurId,
        fournisseurNom: f?.nom ?? 'Fournisseur',
        origine: origine.trim() || null,
        lignes,
        note: note.trim() || null,
        userId: user.uid,
        auteurNom: auteur.utilisateurNom,
        auteurFonction: auteur.utilisateurFonction,
      });
      router.push(`/ensemble/importations/${id}`);
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  if (!user) return null;

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">

      {/* Les actions restent atteignables pendant qu'on parcourt un long
          catalogue. */}
      <header className="sticky top-0 z-30 border-b border-gray-100 bg-white/90 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
        <div className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Ship size={18} className="text-indigo-500" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
              Nouvelle importation
            </h1>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push('/ensemble?onglet=importations')}
              className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800">
              Annuler
            </button>
            <button onClick={enregistrer} disabled={enCours || !pret}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Enregistrer
            </button>
          </div>
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8">

        <div className="mb-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                Destination
              </label>
              {/* Le dossier se mène d'ici, mais la marchandise va quelque
                  part : c'est ce site qui la comptera et la vendra. */}
              <SelectCherchable valeur={siteId} onChange={setSiteId}
                options={sites.map(s => ({ valeur: s.id, label: s.nom }))}
                vide="Choisir le site" />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                Fournisseur
              </label>
              <SelectCherchable valeur={fournisseurId} onChange={setFournisseurId}
                options={fournisseurs.map(f => ({ valeur: f.id, label: f.nom }))}
                vide={siteId ? 'Aucun fournisseur' : 'Choisir d’abord le site'} />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
                Origine
              </label>
              {/* D'où elle part : un délai de Guangzhou n'est pas celui de
                  Dubaï, et le savoir change ce qu'on attend. */}
              <input type="text" value={origine}
                onChange={e => setOrigine(e.target.value)}
                placeholder="Ex. Guangzhou"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
            </div>
          </div>
        </div>

        {siteId ? (
          <SelecteurProduits
            produits={produits} lignes={lignes}
            onChange={setLignes}
            coutEditable montrerStock={false} labelCout="Coût d'achat"
            futur
          />
        ) : (
          <div className="rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <p className="text-xs text-gray-400">
              Choisissez d’abord le site de destination : c’est son rayon
              que cette importation garnira.
            </p>
          </div>
        )}

        {erreur && <p className="mt-3 text-xs text-red-500">{erreur}</p>}

        <div className="mt-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <label className="mb-1.5 block text-xs font-bold text-gray-500 dark:text-gray-400">
            Note
          </label>
          <input type="text" value={note} onChange={e => setNote(e.target.value)}
            placeholder="Facultatif"
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />

          <div className="mt-4 flex items-baseline justify-between border-t border-gray-100 pt-3 dark:border-gray-800">
            <span className="text-xs text-gray-400">Marchandise</span>
            <span className="text-lg font-bold text-gray-900 dark:text-gray-100">
              {total.toLocaleString('fr-FR')} FCFA
            </span>
          </div>
          {/* Les frais du voyage ne se saisissent pas ici : le fret se
              connaît à l'expédition, les droits au dédouanement. Ils
              s'ajoutent sur la fiche, quand ils tombent. */}
          <p className="mt-1.5 text-[11px] text-gray-400">
            Les frais du voyage — fret, douane, transit — s’ajouteront sur
            la fiche, au fur et à mesure qu’ils se connaîtront.
          </p>
        </div>
      </div>
    </div>
  );
}
