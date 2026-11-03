// GenrePicker.tsx - AniStream's "Categories" overlay: the site's genres in the
// shared category picker.
import React, { useEffect, useMemo, useState } from 'react';
import { CategoryPicker } from 'streamkit/ui/CategoryPicker.tsx';
import { getGenres, type Genre } from '../providers/catalogService';

interface GenrePickerProps {
  open: boolean;
  selectedSlug?: string;
  onSelect: (genre: Genre) => void;
  onClose: () => void;
}

export const GenrePicker: React.FC<GenrePickerProps> = ({ open, selectedSlug, onSelect, onClose }) => {
  const [genres, setGenres] = useState<Genre[]>([]);

  useEffect(() => {
    if (open && genres.length === 0) getGenres().then(setGenres);
  }, [open, genres.length]);

  const sections = useMemo(
    () => [{ items: genres.map(g => ({ key: g.slug, name: g.name })) }],
    [genres]
  );

  return (
    <CategoryPicker
      open={open}
      sections={sections}
      selectedKey={selectedSlug}
      onSelect={slug => { const g = genres.find(x => x.slug === slug); if (g) onSelect(g); }}
      onClose={onClose}
    />
  );
};
