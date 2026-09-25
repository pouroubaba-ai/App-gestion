'use client';
import { useEffect, useState } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { formatMontant } from '@/lib/format';
import { enregistrerMouvement, enUnitesBase, type SensMouvement, type Mouvement } from '@/lib/mouvements';
import { X, Check, Loader2 } from 'lucide-react';
import { SelectCherchable } from '@/components/Champs';
import { auteurCourant } from '@/lib/auteur';

interface Emballage { nom: string; quantite: number }
interface Variante { cle: string; stock: number; coutMoyen: number; prixVente?: number }

interface Produit {
  id: string;
  designation: string;
  unite: string;
  prixVente: number;
  coutMoyen: number;
  stock: number;
  emballages?: Emballage[];
  variantes?: Variante[];
}

interface Partenaire { id: string; nom: string; rolesFournisseur: boolean; rolesClient: boolean }

interface Props {
  siteId: string;
  userId: string;
  produit: Produit;
  onClose: () => void;
  onEnregistre: (m: Mouvement) => void;
}

const MOTIFS: Record<SensMouvement, { key: string; label: string }[]> = {
  entree: [
    { key: 'achat',         label: 'Achat' },
    { key: 'transfert',     label: 'Transfert' },
    { key: 'retour_client', label: 'Retour client' },
    { key: 'reajustement',  label: 'Réajustement' },
  ],
  sortie: [
    { key: 'vente',              label: 'Vente' },
    { key: 'transfert',          label: 'Transfert' },
    { key: 'retour_fournisseur', label: 'Retour fournisseur' },
    { key: 'perte',              label: 'Perte / casse' },
    { key: 'reajustement',       label: 'Réajustement' },
  ],
};

function parseMontant(s: string): number {
  return parseInt(s.replace(/[\s ]/g, ''), 10) || 0;
}
function todayStr() { return new Date().toISOString().split('T')[0]; }

export default function ModalMouvement({ siteId, userId, produit, onClose, onEnregistre }: Props) {
  const emballages = produit.emballages ?? [];
  const variantes = produit.variantes ?? [];
  const uniteLabel = produit.unite.toLowerCase();

  const [sens, setSens] = useState<SensMouvement>('entree');
  const [motif, setMotif] = useState('achat');
  const [date, setDate] = useState(todayStr());
  const [varianteCle, setVarianteCle] = useState(variantes[0]?.cle ?? '');
  const [quantite, setQuantite] = useState('');
  const [emballage, setEmballage] = useState('');
  const [valeurUnitaire, setValeurUnitaire] = useState('');
  const [partenaireId, setPartenaireId] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [partenaires, setPartenaires] = useState<Partenaire[]>([]);
  const [saving, setSaving] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    const load = async () => {
      const snap = await getDocs(query(collection(db, 'partenaires'), where('siteId', '==', siteId)));
      setPartenaires(snap.docs.map(d => ({ id: d.id, ...d.data() } as Partenaire)));
    };
    load();
  }, [siteId]);

  /* le motif doit rester valide quand on change de sens */
  useEffect(() => {
    setMotif(MOTIFS[sens][0].key);
    setValeurUnitaire('');
  }, [sens]);

  const variante = variantes.find(v => v.cle === varianteCle);
  const stockActuel = variante ? variante.stock : produit.stock;
  const coutActuel = variante ? variante.coutMoyen : produit.coutMoyen;
  const prixActuel = variante?.prixVente ?? produit.prixVente;

  const qte = parseMontant(quantite);
  const qteUnites = enUnitesBase(qte, emballage, emballages);
  /* un transfert se valorise au coût moyen : ce n'est pas une décision commerciale */
  const valeur = motif === 'transfert' ? coutActuel : parseMontant(valeurUnitaire);
  const total = valeur * qteUnites;
  /* une sortie ne peut pas dépasser le stock disponible */
  const depassement = sens === 'sortie' && qteUnites > stockActuel;

  const besoinPartenaire = (sens === 'entree' && motif === 'achat')
    || (sens === 'sortie' && motif === 'vente');
  const partenairesFiltres = partenaires.filter(p =>
    sens === 'entree' ? p.rolesFournisseur : p.rolesClient);

  const sansSaisieValeur = motif === 'perte' || motif === 'transfert';
  const valide = qte > 0 && !depassement && (sansSaisieValeur || valeur > 0);

  async function enregistrer() {
    if (!valide) return;
    setSaving(true);
    setErreur('');
    try {
      const p = partenaires.find(x => x.id === partenaireId);
      /* Qui fait le geste : son nom et sa fonction se figent sur le
         mouvement, la fiche pourra changer sans réécrire l'archive. */
      const auteur = await auteurCourant(siteId, userId);
      const m = await enregistrerMouvement({
        siteId, userId,
        utilisateurNom: auteur.utilisateurNom,
        utilisateurFonction: auteur.utilisateurFonction,
        produitId: produit.id,
        varianteCle: varianteCle || null,
        sens, motif, date,
        quantite: qte,
        emballage: emballage || null,
        valeurUnitaire: valeur,
        partenaireId: partenaireId || null,
        partenaireNom: p?.nom ?? null,
        documentId: documentId.trim() || null,
      });
      onEnregistre(m);
    } catch (e: any) {
      setErreur(e?.message ?? 'Enregistrement impossible.');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-md shadow-xl p-5 flex flex-col max-h-[85vh] min-h-0">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">Nouveau mouvement</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X size={18} /></button>
        </div>

        <div className="flex gap-2 mb-4 shrink-0">
          {(['entree', 'sortie'] as const).map(s => (
            <button key={s} type="button" onClick={() => setSens(s)}
              className={`flex-1 py-2 rounded-xl border text-xs font-bold transition-all ${sens === s
                ? s === 'entree'
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-400 text-green-700 dark:text-green-400'
                  : 'bg-red-50 dark:bg-red-900/20 border-red-400 text-red-600 dark:text-red-400'
                : 'border-gray-200 dark:border-gray-700 text-gray-500'}`}>
              {s === 'entree' ? 'Entrée' : 'Sortie'}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 min-h-0 pr-1">
          <p className="text-xs font-bold text-gray-400 uppercase mb-1">Motif</p>
          <select value={motif} onChange={e => setMotif(e.target.value)}
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500">
            {MOTIFS[sens].map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>

          {variantes.length > 0 && (
            <>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Variante</p>
              <select value={varianteCle} onChange={e => setVarianteCle(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                {variantes.map(v => <option key={v.cle} value={v.cle}>{v.cle}</option>)}
              </select>
              <p className="text-xs text-gray-400 mb-4">
                Stock actuel : <span className="font-bold text-gray-600 dark:text-gray-300">{stockActuel}</span> {uniteLabel}s
              </p>
            </>
          )}

          <p className="text-xs font-bold text-gray-400 uppercase mb-1">Quantité</p>
          <div className="flex gap-2">
            <input type="number" min={0} placeholder="Ex. 12" value={quantite}
              onChange={e => setQuantite(e.target.value)}
              className={`flex-1 min-w-0 px-3 py-2.5 rounded-xl border bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 ${depassement ? 'border-red-400' : 'border-gray-200 dark:border-gray-700'}`} />
            {emballages.length > 0 && (
              <select value={emballage} onChange={e => setEmballage(e.target.value)}
                className="w-28 shrink-0 px-2 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="">{uniteLabel}</option>
                {emballages.map(e => <option key={e.nom} value={e.nom}>{e.nom}</option>)}
              </select>
            )}
          </div>
          {depassement
            ? <p className="text-xs text-red-500 mt-1 mb-4">Stock insuffisant : {stockActuel} {uniteLabel}s disponibles.</p>
            : emballage && qte > 0
              ? <p className="text-xs text-gray-400 mt-1 mb-4">Soit <span className="font-bold text-gray-600 dark:text-gray-300">{qteUnites}</span> {uniteLabel}s.</p>
              : <div className="mb-4" />}

          {!sansSaisieValeur && (
            <>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">
                {sens === 'entree' ? 'Coût unitaire' : 'Prix unitaire'}
              </p>
              <input type="number" min={0}
                placeholder={sens === 'entree'
                  ? (coutActuel > 0 ? String(coutActuel) : 'Ex. 500')
                  : (prixActuel > 0 ? String(prixActuel) : 'Ex. 750')}
                value={valeurUnitaire} onChange={e => setValeurUnitaire(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 mb-1 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <p className="text-xs text-gray-400 mb-4">
                Par {uniteLabel}. {total > 0 && <>Total : <span className="font-bold text-gray-600 dark:text-gray-300">{formatMontant(total)}</span>.</>}
              </p>
            </>
          )}

          {motif === 'transfert' && (
            <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/40 rounded-xl px-3 py-2.5 mb-4">
              <p className="text-xs text-indigo-700 dark:text-indigo-400">
                Valorisé au coût moyen ({formatMontant(coutActuel)}) — un transfert déplace la valeur sans la réaliser, donc sans bénéfice ni perte.
              </p>
            </div>
          )}

          {besoinPartenaire && (
            <>
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">
                {sens === 'entree' ? 'Fournisseur' : 'Client'}
              </p>
              <div className="mb-4">
                <SelectCherchable valeur={partenaireId} onChange={setPartenaireId}
                  options={[{ valeur: '', label: '— aucun —' },
                    ...partenairesFiltres.map(x => ({ valeur: x.id, label: x.nom }))]}
                  vide="Aucun partenaire" />
              </div>
            </>
          )}

          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Date</p>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-gray-400 uppercase mb-1">Document</p>
              <input type="text" placeholder="N° facture…" value={documentId}
                onChange={e => setDocumentId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>

          {sens === 'sortie' && !sansSaisieValeur && valeur > 0 && qteUnites > 0 && (() => {
            const benef = (valeur - coutActuel) * qteUnites;
            return (
              <p className={`text-xs mt-3 ${benef >= 0 ? 'text-gray-400' : 'text-red-500'}`}>
                {benef >= 0 ? 'Bénéfice' : 'Perte'} de{' '}
                <span className={`font-bold ${benef >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {formatMontant(Math.abs(benef))}
                </span>{' '}
                — coût moyen actuel {formatMontant(coutActuel)}.
              </p>
            );
          })()}

          {motif === 'perte' && qteUnites > 0 && coutActuel > 0 && (
            <p className="text-xs text-red-500 mt-3">
              Perte de <span className="font-bold">{formatMontant(coutActuel * qteUnites)}</span> — le coût du stock détruit.
            </p>
          )}

          {sens === 'entree' && motif !== 'transfert' && valeur > 0 && qteUnites > 0 && valeur !== coutActuel && (
            <p className="text-xs text-gray-400 mt-3">
              Le coût moyen passera de {formatMontant(coutActuel)} à{' '}
              <span className="font-bold text-gray-600 dark:text-gray-300">
                {formatMontant(stockActuel <= 0 ? valeur
                  : Math.round((stockActuel * coutActuel + qteUnites * valeur) / (stockActuel + qteUnites)))}
              </span>.
            </p>
          )}

          {erreur && <p className="text-xs text-red-500 mt-3">{erreur}</p>}
        </div>

        <div className="flex gap-3 shrink-0 pt-4">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-500">Annuler</button>
          <button onClick={enregistrer} disabled={saving || !valide}
            className="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold flex items-center justify-center gap-2 transition-colors">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Enregistrer
          </button>
        </div>
      </div>
    </div>
  );
}
