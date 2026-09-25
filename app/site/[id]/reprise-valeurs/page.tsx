'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { corrigerValeursEmballage, type CorrectionValeur } from '@/lib/reprise';
import { formatMontant } from '@/lib/format';

/**
 * Écran temporaire : remet d'aplomb les mouvements écrits avant que
 * l'emballage soit pris en compte dans les valeurs. À supprimer une fois
 * la reprise passée.
 */
export default function RepriseValeursPage() {
  const params = useParams();
  const siteId = params.id as string;
  const [liste, setListe] = useState<CorrectionValeur[] | null>(null);
  const [fait, setFait] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    corrigerValeursEmballage(siteId, true)
      .then(setListe)
      .catch(e => setErreur(e?.message ?? 'Lecture impossible.'));
  }, [siteId]);

  async function appliquer() {
    setEnCours(true); setErreur('');
    try {
      await corrigerValeursEmballage(siteId, false);
      setFait(true);
      setListe(await corrigerValeursEmballage(siteId, true));
    } catch (e: any) {
      setErreur(e?.message ?? 'Écriture impossible.');
    } finally { setEnCours(false); }
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 p-8">
      <div className="max-w-4xl mx-auto bg-white dark:bg-gray-900 rounded-2xl border border-gray-100 dark:border-gray-800 p-6">
        <p className="text-sm font-bold mb-4">Reprise des valeurs par emballage</p>

        {erreur && <p className="text-xs text-red-500 mb-3">{erreur}</p>}
        {liste === null && <p className="text-xs text-gray-400">Lecture…</p>}

        {liste && liste.length === 0 && (
          <p className="text-xs text-green-600 font-bold">
            {fait ? 'Corrigé : plus aucun écart.' : 'Aucun mouvement à corriger.'}
          </p>
        )}

        {liste && liste.length > 0 && (
          <>
            <table className="w-full text-sm mb-4">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-100 dark:border-gray-800">
                  <th className="text-center font-medium pb-2">Produit</th>
                  <th className="text-center font-medium pb-2">Emballage</th>
                  <th className="text-center font-medium pb-2">Qté</th>
                  <th className="text-center font-medium pb-2">Coût avant</th>
                  <th className="text-center font-medium pb-2">Coût après</th>
                  <th className="text-center font-medium pb-2">Total avant</th>
                  <th className="text-center font-medium pb-2">Total après</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {liste.map(c => (
                  <tr key={c.id}>
                    <td className="py-2 text-center">{c.produit}</td>
                    <td className="py-2 text-center text-gray-500">{c.emballage}</td>
                    <td className="py-2 text-center">{c.quantite}</td>
                    <td className="py-2 text-center text-red-500">{formatMontant(c.coutAvant)}</td>
                    <td className="py-2 text-center text-green-600 font-bold">{formatMontant(c.coutApres)}</td>
                    <td className="py-2 text-center text-red-500">{formatMontant(c.valeurAvant)}</td>
                    <td className="py-2 text-center text-green-600 font-bold">{formatMontant(c.valeurApres)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button onClick={appliquer} disabled={enCours}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-bold rounded-xl">
              {enCours ? 'Écriture…' : `Corriger ${liste.length} mouvement${liste.length > 1 ? 's' : ''}`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
