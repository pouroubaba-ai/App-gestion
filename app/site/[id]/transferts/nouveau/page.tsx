'use client';
import { produitsDuSite } from '@/lib/produits-site';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs, getDoc, doc, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { Loader2, Check, ArrowLeftRight, AlertTriangle } from 'lucide-react';
import SelecteurProduits, { ProduitChoisissable } from '../../components/SelecteurProduits';
import { LigneFlux, referenceFlux, peutInitierTransfert, type Role } from '@/lib/flux-marchandise';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { SelectCherchable } from '@/components/Champs';
import { estEnsemble, marqueOrigine, racineRetour } from '@/lib/retour';

interface SiteBref { id: string; nom: string }

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

export default function NouveauTransfertPage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const siteId = params.id as string;
  const searchParams = useSearchParams();
  /* On expédie toujours depuis un site, même parti de la vue d'ensemble :
     l'écran de retour, lui, reste celui d'où l'on vient. */
  const vientEnsemble = estEnsemble(searchParams);

  const [sites, setSites] = useState<SiteBref[]>([]);
  const [produits, setProduits] = useState<ProduitChoisissable[]>([]);
  const [loading, setLoading] = useState(true);

  /* Le bouton caché n'empêche pas d'ouvrir l'adresse : la page se garde
     elle-même. `null` en rôle vaut « aucune restriction », d'où le drapeau.
     Les achats et les ventes se gardaient déjà ainsi ; le transfert, non —
     on entrait dans le formulaire et on pouvait l'envoyer. */
  const [role, setRole] = useState<RoleSite | null>(null);
  const [roleLu, setRoleLu] = useState(false);

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => { setRole(r); setRoleLu(true); })
      .catch(() => setRoleLu(true));
  }, [user, siteId, activite?.adminUid]);

  const [destId, setDestId] = useState('');
  const [lignes, setLignes] = useState<LigneFlux[]>([]);
  const [date, setDate] = useState(aujourdhui());
  const [note, setNote] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');
  /* Ce que la destination détient déjà de chaque produit. Sans le savoir,
     on envoie à l'aveugle : un site qui a payé sa marchandise plus cher
     verrait son coût moyen bouger sans qu'on l'ait annoncé. */
  const [chezDest, setChezDest] = useState<Record<string, {
    stock: number; coutMoyen: number; prixVente: number;
  }>>({});

  useEffect(() => {
    if (!user) return;
    (async () => {
      /* Les destinations sont les sites de l'activité, pas ceux que ce
         compte possède : un membre — gérant, responsable des commandes —
         n'en possède aucun. Lire par propriétaire lui rendait une liste
         vide, et la page annonçait qu'aucune destination n'existait alors
         qu'il expédie vers elles tous les jours. */
      const siteDoc = await getDoc(doc(db, 'sites', siteId));
      const activiteId = siteDoc.data()?.activiteId ?? null;

      const [sitesSnap, prodSnap] = await Promise.all([
        getDocs(query(
          collection(db, 'sites'),
          activiteId
            ? where('activiteId', '==', activiteId)
            /* Un site sans activité est antérieur à leur introduction :
               son propriétaire reste le seul lien connu. */
            : where('userId', '==', siteDoc.data()?.userId ?? user.uid))),
        produitsDuSite(siteId),
      ]);
      setSites(sitesSnap.docs.map(d => ({ id: d.id, nom: d.data().nom as string })));
      /* `produitsDuSite` a deja joint le produit et la detention : les
         objets arrivent complets. */
      setProduits(prodSnap as ProduitChoisissable[]);
      setLoading(false);
    })();
  }, [siteId, user]);

  /* La destination change : on relit ce qu'elle détient. Rien tant
     qu'aucune n'est choisie — il n'y a rien à confronter. */
  useEffect(() => {
    if (!destId) { setChezDest({}); return; }
    let vivant = true;
    produitsDuSite(destId)
      .then(liste => {
        if (!vivant) return;
        const par: Record<string, any> = {};
        for (const p of liste) {
          par[p.id] = {
            stock: p.stock ?? 0,
            coutMoyen: p.coutMoyen ?? 0,
            prixVente: p.prixVente ?? 0,
          };
        }
        setChezDest(par);
      })
      .catch(() => { if (vivant) setChezDest({}); });
    return () => { vivant = false; };
  }, [destId]);

  const autres = sites.filter(s => s.id !== siteId);
  const nomSource = sites.find(s => s.id === siteId)?.nom ?? '—';
  const total = lignes.reduce((s, l) => s + l.quantiteDemandee * l.valeurUnitaire, 0);

  /* Une ligne à zéro n'est pas ignorée mais bloquante : la laisser passer
     silencieusement ferait disparaître un produit que l'utilisateur croit avoir envoyé. */
  const lignesCompletes = lignes.length > 0 && lignes.every(l => l.produitId && l.quantiteDemandee > 0);

  /* Le prix ne peut pas descendre sous ce que la marchandise coûtera au
     receveur : le champ y remonte de lui-même. Rien à bloquer ici — un
     bouton éteint n'aurait pas dit quoi corriger. */
  const pretAEnregistrer = !!destId && lignesCompletes && autres.length > 0;

  async function enregistrer() {
    setErreur('');
    if (!pretAEnregistrer) return;

    setEnCours(true);
    try {
      const dest = autres.find(s => s.id === destId)!;
      const source = sites.find(s => s.id === siteId);
      const ref = await addDoc(collection(db, 'transferts'), {
        reference: referenceFlux('TR', date),
        siteSourceId: siteId,
        siteSourceNom: source?.nom ?? '—',
        siteDestId: destId,
        siteDestNom: dest.nom,
        etat: 'en_cours',
        /* Le prix que la destination pratiquera voyage avec la ligne : il
           s'appliquera à la confirmation, quand la marchandise entrera
           vraiment dans son rayon. Sans lui, elle recevrait un produit sans
           prix et le vendrait à zéro. */
        /* Le prix que la destination pratiquera voyage avec la ligne : il
           s'appliquera à la confirmation, quand la marchandise entrera
           vraiment dans son rayon. */
        lignes,
        dateInitiation: date,
        parInitiation: user!.uid,
        note: note.trim() || null,
        userId: user!.uid,
        createdAt: serverTimestamp(),
      });
      /* Le dossier hérite de l'origine : il se refermera là où l'on a
         commencé, dans le site ou dans l'ensemble. */
      router.push(
        `/site/${siteId}/transferts/${ref.id}${marqueOrigine(vientEnsemble)}`);
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  /* Initier un transfert, c'est décider qu'une marchandise quitte un site :
     celui qui fait avancer les dossiers charge et compte, il ne décide pas
     du mouvement. */
  if (roleLu && !peutInitierTransfert(role as Role | null)) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Ce rôle ne crée pas de dossier.</p>
      <button onClick={() => router.push(`${racineRetour(vientEnsemble, siteId)}?onglet=transferts`)}
        className="px-4 py-2 text-xs font-bold text-indigo-600 hover:underline">
        Retour
      </button>
    </div>
  );

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <Loader2 size={24} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">

      {/* Les actions restent atteignables pendant qu'on parcourt un long catalogue. */}
      <header className="sticky top-0 z-30 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ArrowLeftRight size={18} className="text-indigo-500" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Initier un transfert</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push(`${racineRetour(vientEnsemble, siteId)}?onglet=transferts`)}
              className="px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
              Annuler
            </button>
            <button onClick={enregistrer} disabled={enCours || !pretAEnregistrer}
              className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-colors">
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Initier
            </button>
          </div>
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8">

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">

          {autres.length === 0 ? (
            <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-xl">
              <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Aucun autre site n'existe. Un transfert a besoin d'une destination.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {/* La marchandise part d'ici : on le montre sans le proposer,
                  sinon on laisserait croire qu'un autre site peut expédier
                  à notre place. */}
              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Source</label>
                <div className="w-full rounded-xl border border-gray-200 bg-gray-100 px-3 py-2 text-sm font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                  {nomSource}
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Destination</label>
                <SelectCherchable valeur={destId} onChange={setDestId}
                  options={autres.map(a => ({ valeur: a.id, label: a.nom }))}
                  vide="Aucun autre site" />
              </div>

              <div>
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Date</label>
                <input type="date" value={date} max={aujourdhui()}
                  onChange={e => setDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>
          )}
        </div>

        {/* Ce que la destination détient déjà se lit dans la ligne du
            produit, avec le reste : deux tableaux pour un même envoi
            obligeaient à faire l'aller-retour entre eux. */}
        <SelecteurProduits
          produits={produits} lignes={lignes} onChange={setLignes}
          coutEditable={false} montrerStock labelCout="Coût moyen"
          chezDestinataire={destId ? chezDest : undefined}
          nomDestinataire={autres.find(a => a.id === destId)?.nom ?? null}
        />


        {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}

        <div className="mt-4 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">

          <div className="pb-4 mb-4 border-b border-gray-100 dark:border-gray-800">
            <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Note</label>
            <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Facultatif"
              className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>

          <div className="flex justify-end">
            <div className="text-right">
              <p className="text-xs text-gray-400">Valeur au coût moyen</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{formatMontant(total)}</p>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
