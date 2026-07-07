import React, { useState } from 'react';

// Chip-based list editor. Type a term and press Enter or comma to add it;
// Backspace on an empty field removes the last chip; pasting a comma-
// separated string adds them all. Values are always an array of strings.
export default function TagInput({ value = [], onChange, placeholder, tone = 'accent' }) {
  const [draft, setDraft] = useState('');

  const addTerms = (raw) => {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const merged = [...value];
    for (const p of parts) {
      if (!merged.some(v => v.toLowerCase() === p.toLowerCase())) merged.push(p);
    }
    onChange(merged);
  };

  const commit = () => {
    if (draft.trim()) addTerms(draft);
    setDraft('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const remove = (term) => onChange(value.filter(v => v !== term));

  const chipClass = tone === 'danger' ? 'chip chip-danger' : 'chip';

  return (
    <div
      className="tag-input"
      onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
    >
      {value.map((term, i) => (
        <span key={`${term}-${i}`} className={chipClass}>
          {term}
          <button
            type="button"
            className="chip-remove"
            title="Remove"
            onClick={(e) => { e.stopPropagation(); remove(term); }}
          >✕</button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (text.includes(',')) { e.preventDefault(); addTerms(text); }
        }}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : ''}
        className="tag-input-field"
      />
    </div>
  );
}
