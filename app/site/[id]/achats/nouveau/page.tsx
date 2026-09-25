'use client';
import { produitsDuSite } from '@/lib/produits-site';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/lib/auth-context';
import { roleSurSite, type RoleSite } from '@/lib/roles';
import { chargerDisponible } from '@/lib/attente-caisse';
import DisponibleCaisse from '../../components/DisponibleCaisse';
import { auteurCourant, auteurEtape } from '@/lib/auteur';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { formatMontant } from '@/lib/format';
import { Loader2, Check, ShoppingCart } from 'lucide-react';
import SelecteurProduits, { ProduitChoisissable } from '../../components/SelecteurProduits';
import { Achat, LigneFlux, referenceFlux, confirmerAchat } from '@/lib/flux-marchandise';
import { SelectCherchable, ChampNombre } from '@/components/Champs';
import { estEnsemble, marqueOrigine, racineRetour } from '@/lib/retour';
import { sansAttendreLeReseau } from '@/lib/reseau';
import { chargerCaisseDuSite, soldeCaisse } from '@/lib/caisse';
import { enregistrerVersement } from '@/lib/versements-collection';

interface FournisseurBref { id: string; nom: string }

function aujourdhui() { return new Date().toISOString().split('T')[0]; }

export default function NouvelAchatPage() {
  const { user, activite } = useAuth();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const siteId = params.id as string;
  /* On cree toujours dans un site, meme parti de la vue d'ensemble : c'est
     un site qui recoit la marchandise. L'ecran de retour, lui, reste celui
     d'ou l'on vient. */
  const vientEnsemble = estEnsemble(searchParams);

  const [fournisseurs, setFournisseurs] = useState<FournisseurBref[]>([]);
  const [produits, setProduits] = useState<ProduitChoisissable[]>([]);
  const [loading, setLoading] = useState(true);
  /* Le bouton caché n'empêche pas d'ouvrir l'adresse : la page se garde
     elle-même. `null` en rôle vaut « aucune restriction », d'où le drapeau. */
  const [role, setRole] = useState<RoleSite | null>(null);
  const [roleLu, setRoleLu] = useState(false);

  useEffect(() => {
    if (!user) return;
    roleSurSite(user.uid, siteId, activite?.adminUid)
      .then(r => { setRole(r); setRoleLu(true); })
      .catch(() => setRoleLu(true));
  }, [user, siteId, activite?.adminUid]);

  const [fournisseurId, setFournisseurId] = useState('');
  const [lignes, setLignes] = useState<LigneFlux[]>([]);
  /* immédiat = payé et reçu dans le même geste ; sinon la marchandise suivra */
  const [immediat, setImmediat] = useState(true);
  /* « immédiat » veut dire reçu à l'instant : la date se verrouille sur le jour.
     Une commande passée se saisit en « à venir », puis se reçoit à sa vraie date. */
  /* ce qu'on paie tout de suite : une avance avant réception,
     un versement partiel quand la marchandise est déjà là */
  const [verse, setVerse] = useState(0);
  /* Payer sort de l'argent d'un tiroir qui n'est pas infini : sans ce
     solde, on promettait au fournisseur ce qu'on n'avait pas, et la caisse
     passait en negatif sans que rien ne le signale. */
  const [soldeCaisseSite, setSoldeCaisseSite] = useState<number | null>(null);
  /* Ce qu'on peut encore laisser sortir : le solde moins ce qui est déjà
     déclaré et pas encore passé par le tiroir. Comparé au seul solde, les
     sorties s'enchaînaient sur un chiffre qui ne bougeait pas. */
  const [engageCaisse, setEngageCaisse] = useState(0);
  const [soldeReelCaisse, setSoldeReelCaisse] = useState<number | null>(null);

  const [date, setDate] = useState(aujourdhui());
  const [note, setNote] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [partSnap, prodSnap] = await Promise.all([
        getDocs(query(collection(db, 'partenaires'),
          where('siteId', '==', siteId), where('userId', '==', user.uid))),
        produitsDuSite(siteId),
      ]);
      /* Ce que le tiroir contient : c'est lui qui borne le versement. */
      chargerDisponible(siteId)
        .then(d => {
          setSoldeCaisseSite(d.disponible);
          setSoldeReelCaisse(d.solde);
          setEngageCaisse(d.engage);
        })
        .catch(() => setSoldeCaisseSite(null));
      /* un partenaire peut cumuler les deux rôles : seul le côté fournisseur compte ici */
      setFournisseurs(partSnap.docs
        .filter(d => d.data().rolesFournisseur)
        .map(d => ({ id: d.id, nom: d.data().nom as string })));
      /* `produitsDuSite` a deja joint le produit et la detention : les
         objets arrivent complets. */
      setProduits(prodSnap as ProduitChoisissable[]);
      setLoading(false);
    })();
  }, [siteId, user]);

  const total = lignes.reduce((s, l) => s + l.quantiteDemandee * l.valeurUnitaire, 0);
  /* ce qui n'est pas versé reste dû : payer ne conditionne pas la réception */
  const reste = Math.max(0, total - verse);
  /* Payer d'avance plus que le total commandé n'a pas de sens : le trop-perçu
     n'aurait aucune contrepartie. On borne au lieu d'accepter puis corriger. */
  const avanceExcessive = verse > total;
  /* Et l'on ne sort pas d'un tiroir ce qu'il ne contient pas : un versement
     au-delà du solde laissait la caisse négative, sans mouvement pour
     l'expliquer. Le solde inconnu ne bloque pas — il n'a pas été lu. */
  const depasseCaisse = soldeCaisseSite != null && verse > soldeCaisseSite;
  /* Le plafond du champ est le plus contraignant des deux. */
  const plafondVerse = soldeCaisseSite != null
    ? Math.min(total, soldeCaisseSite)
    : total;

  /* Une ligne à zéro n'est pas ignorée mais bloquante : la laisser passer
     silencieusement ferait disparaître un produit que l'utilisateur croit avoir commandé. */
  const lignesCompletes = lignes.length > 0 && lignes.every(l => l.produitId && l.quantiteDemandee > 0);
  const pretAEnregistrer = !!fournisseurId && lignesCompletes
    && !avanceExcessive && !depasseCaisse;

  async function enregistrer() {
    setErreur('');
    if (!pretAEnregistrer) return;

    setEnCours(true);
    try {
      const f = fournisseurs.find(x => x.id === fournisseurId);
      const dateFinale = immediat ? aujourdhui() : date;
      /* un achat immédiat est reçu dans le même geste : le demandé vaut le reçu */
      const lignesFinales = immediat
        ? lignes.map(l => ({ ...l, quantiteRecue: l.quantiteDemandee }))
        : lignes;

      /* Recopié une fois, réutilisé par chaque étape du dossier. */

      const auteur = await auteurEtape(siteId, user!.uid, user!.displayName);

      const donnees = {
        reference: referenceFlux('AC', dateFinale),
        siteId,
        fournisseurId,
        fournisseurNom: f?.nom ?? '—',
        etat: immediat ? 'recu' : 'en_attente',
        lignes: lignesFinales,
        /* Le dossier naît à zéro : `enregistrerVersement` incrémente ce
           total lui-même. L'inscrire ici aussi le comptait deux fois — un
           achat de 5 000 payé d'un coup affichait « Versé 10 000 ».
           Le versement ne vit plus dans le dossier : il a sa collection,
           écrite juste après, et elle seule sort l'argent de la caisse. */
        avanceVersee: 0,
        versements: [],
        dateCommande: dateFinale,
        dateReception: immediat ? dateFinale : null,
        parCommande: user!.uid,
        parReception: immediat ? user!.uid : null,
        /* Le nom et la fonction à côté de l'identifiant : seul, il oblige à
           ouvrir la fiche, et ne dit plus rien quand elle a disparu. */
        auteurCommande: auteur,
        auteurReception: immediat ? auteur : null,
        note: note.trim() || null,
        userId: user!.uid,
        createdAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, 'achats'), donnees);

      /* Payer sort l'argent du tiroir. Passer par la collection écrit les
         deux faits d'un coup — le versement et son mouvement de caisse —
         au lieu du seul montant recopié dans le dossier. */
      if (verse > 0) {
        await enregistrerVersement({
          adminUid: activite?.adminUid ?? null,
          siteId, userId: user!.uid,
          date: dateFinale,
          montant: verse,
          /* régler un fournisseur sort de l'argent */
          sens: 'sortie',
          /* Immédiat : la marchandise est là, c'est un règlement. À venir :
             l'argent part avant elle, c'est une avance. */
          motif: immediat ? 'reglement' : 'avance',
          partenaireId: fournisseurId,
          partenaireNom: f?.nom ?? null,
          role: 'fournisseur',
          achatId: ref.id,
          reference: donnees.reference,
          par: user!.uid,
          ...(await auteurCourant(siteId, user!.uid, user!.displayName)),
        });
      }

      /* L'étape de confirmation sert à trancher un écart. En immédiat, le reçu
         vaut le commandé : aucun écart n'est possible, l'achat se conclut ici même.

         La confirmation lit le stock avant de l'écrire : hors ligne, cette
         lecture n'aboutit pas. On la laisse se terminer seule plutôt que de
         figer l'écran — le dossier est créé, le reste suivra. */
      if (immediat) {
        const suite = confirmerAchat({
          /* `donnees` porte zéro : c'est la collection qui a inscrit le
             versement. La confirmation en a besoin pour savoir s'il faut
             rendre la monnaie — on le lui redonne ici. */
          achat: { ...donnees, avanceVersee: verse, id: ref.id } as unknown as Achat,
          userId: user!.uid, par: user!.uid,
          /* Qui a conclu l'achat, recopié sur le document : une archive doit
             pouvoir le dire même quand la fiche de l'employé a changé. */
          ...(await auteurCourant(siteId, user!.uid, user!.displayName)),
        });
        await sansAttendreLeReseau(suite);
      }

      /* Le dossier nait avec l'origine qu'on lui a transmise : il se
         refermera sur l'ecran d'ou l'on est parti. */
      router.push(`/site/${siteId}/achats/${ref.id}${marqueOrigine(vientEnsemble)}`);
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setEnCours(false);
    }
  }

  /* La déconnexion vide l'utilisateur avant que la navigation aboutisse. */
  if (!user) return null;

  /* Ouvrir un dossier engage le site sur un prix : ce rôle fait avancer ce
     qui existe, il ne crée pas. */
  if (roleLu && role === 'commandes') return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-950">
      <p className="text-sm text-gray-400">Ce rôle ne crée pas de dossier.</p>
      <button onClick={() => router.push(`${racineRetour(vientEnsemble, siteId)}?onglet=achats`)}
        className="px-4 py-2 text-xs font-bold text-indigo-600 hover:underline">
        Retour
      </button>
    </div>
  );

  if (loading || !roleLu) return (
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
            <ShoppingCart size={18} className="text-indigo-500" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Nouvelle commande</h1>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push(`${racineRetour(vientEnsemble, siteId)}?onglet=achats`)}
              className="px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-xl transition-colors">
              Annuler
            </button>
            <button onClick={enregistrer} disabled={enCours || !pretAEnregistrer}
              className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-colors">
              {enCours ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
            </button>
          </div>
        </div>
      </header>

      <div className="w-full p-4 sm:p-6 lg:p-8">

        <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5 mb-4">

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Fournisseur</label>
              <SelectCherchable valeur={fournisseurId} onChange={setFournisseurId}
                options={fournisseurs.map(f => ({ valeur: f.id, label: f.nom }))}
                vide="Aucun fournisseur" />
            </div>

            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Date</label>
              <input type="date" value={immediat ? aujourdhui() : date} disabled={immediat}
                max={aujourdhui()}
                onChange={e => setDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs text-gray-400 mt-1">
                {immediat ? "Reçu aujourd'hui" : 'Date de la commande, passée ou du jour'}
              </p>
            </div>

            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Livraison</label>
              <div className="flex rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                {([
                  { v: true,  label: 'Immédiate' },
                  { v: false, label: 'À venir' },
                ]).map(o => (
                  <button key={String(o.v)}
                    onClick={() => { setImmediat(o.v); if (o.v) setDate(aujourdhui()); }}
                    className={`flex-1 px-3 py-2 text-xs font-bold transition-colors ${immediat === o.v ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:text-indigo-600'}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

        </div>

        <SelecteurProduits
          produits={produits} lignes={lignes}
          onChange={l => {
            setLignes(l);
            /* le total vient de changer : un versé devenu excessif se ramène */
            const t = l.reduce((s, x) => s + x.quantiteDemandee * x.valeurUnitaire, 0);
            setVerse(v => Math.min(v, t));
          }}
          coutEditable montrerStock={false} labelCout="Coût d'achat"
        />

        {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}

        <div className="mt-4 bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 shadow-sm p-5">

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-4 mb-4 border-b border-gray-100 dark:border-gray-800">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-bold text-gray-500 dark:text-gray-400">
                  {immediat ? 'Versé à la réception' : 'Avance versée à la commande'}
                </label>
                {/* « Tout payer » ne promet que ce qu'on peut sortir. */}
                {plafondVerse > 0 && (
                  <button onClick={() => setVerse(plafondVerse)}
                    className="text-xs font-bold text-indigo-600 hover:underline">
                    {soldeCaisseSite != null && soldeCaisseSite < total
                      ? 'Verser le disponible' : 'Tout payer'}
                  </button>
                )}
              </div>
              <ChampNombre valeur={verse} onChange={setVerse} max={plafondVerse}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className={`text-xs mt-1.5 ${avanceExcessive || depasseCaisse ? 'text-red-500' : 'text-gray-400'}`}>
                {avanceExcessive
                  ? `Le versé ne peut pas dépasser le total commandé (${formatMontant(total)}).`
                  : depasseCaisse
                    ? `La caisse ne peut laisser sortir que ${formatMontant(soldeCaisseSite ?? 0)}.`
                    : immediat
                      ? "Payer ne conditionne pas la réception : le solde restera dû au fournisseur."
                      : "Tant que la marchandise n'est pas reçue, ce versement est une avance : l'achat n'existe pas encore au nom du fournisseur."}
              </p>
              {/* Ce que le tiroir contient, dit avant de promettre : sans
                  cela, on découvrait la limite en butant dessus. */}
              {soldeCaisseSite != null && !avanceExcessive && (
                <DisponibleCaisse className="mt-2"
                  solde={soldeReelCaisse ?? soldeCaisseSite}
                  engage={engageCaisse} disponible={soldeCaisseSite} />
              )}
            </div>

            <div>
              <label className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5 block">Note</label>
              <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Facultatif"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>

          <div className="flex justify-end">
            <div className="flex flex-col gap-1 text-sm min-w-[240px]">
              <div className="flex justify-between gap-8">
                <span className="text-gray-400">Total commandé</span>
                <span className="font-bold text-gray-900 dark:text-gray-100">{formatMontant(total)}</span>
              </div>
              <div className="flex justify-between gap-8">
                <span className="text-gray-400">{immediat ? 'Versé' : 'Avance'}</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">{formatMontant(verse)}</span>
              </div>
              <div className="flex justify-between gap-8 pt-1 border-t border-gray-100 dark:border-gray-800">
                <span className="text-gray-400">Reste</span>
                <span className={`font-bold ${reste > 0 ? 'text-orange-500' : 'text-green-600'}`}>
                  {formatMontant(reste)}
                </span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
