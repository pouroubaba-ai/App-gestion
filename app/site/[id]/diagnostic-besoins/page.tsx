'use client';
/* Page de contrôle temporaire : elle montre ce que la collection contient
   et ce que le calcul en déduit. À supprimer une fois la vue construite. */
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { chargerLignesDuSite, type LigneVente } from '@/lib/lignes-vente';
import { besoinsDuSite, type BesoinProduit } from '@/lib/besoins';

export default function DiagnosticBesoins() {
  const params = useParams();
  const siteId = params.id as string;
  const [lignes, setLignes] = useState<LigneVente[]>([]);
  const [besoins, setBesoins] = useState<BesoinProduit[]>([]);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setLignes(await chargerLignesDuSite(siteId));
        setBesoins(await besoinsDuSite(siteId));
      } catch (e: any) { setErreur(e?.message ?? 'échec'); }
    })();
  }, [siteId]);

  return (
    <div className="p-8 font-mono text-xs">
      {erreur && <p className="mb-4 text-red-500">{erreur}</p>}
      <p className="mb-2 font-bold">lignes_vente ({lignes.length})</p>
      <pre id="lignes" className="mb-6 overflow-auto">{JSON.stringify(lignes, null, 1)}</pre>
      <p className="mb-2 font-bold">besoins ({besoins.length})</p>
      <pre id="besoins" className="overflow-auto">{JSON.stringify(besoins, null, 1)}</pre>
    </div>
  );
}
