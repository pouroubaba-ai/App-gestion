'use client';
import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { EnTeteSite } from '@/lib/export-pdf';

/**
 * Charge les informations d'en-tête d'un site pour l'export PDF :
 * nom, adresse, numéro, image. Elles vivent sur le document du site et ne
 * sont pas chargées par les fiches de dossier — on va donc les chercher
 * une fois, à l'ouverture. Le nom de l'activité est fourni à part (il vit
 * dans le contexte d'authentification).
 */
export function useEnteteSite(
  siteId: string,
  activiteNom?: string | null,
): EnTeteSite {
  const [site, setSite] = useState<{
    nom?: string; adresse?: string; numero?: string; imageUrl?: string;
  }>({});

  useEffect(() => {
    if (!siteId) return;
    let vivant = true;
    getDoc(doc(db, 'sites', siteId))
      .then(s => {
        if (!vivant || !s.exists()) return;
        const d = s.data() as any;
        setSite({
          nom: d.nom, adresse: d.adresse,
          numero: d.numero, imageUrl: d.imageUrl,
        });
      })
      .catch(() => { /* en-tête réduit si la lecture échoue */ });
    return () => { vivant = false; };
  }, [siteId]);

  return {
    activite: activiteNom ?? null,
    site: site.nom ?? null,
    adresse: site.adresse ?? null,
    numero: site.numero ?? null,
    imageUrl: site.imageUrl ?? null,
  };
}
