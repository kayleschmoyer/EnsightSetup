import React, { useState, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from './ui/dialog';
import {
  Users, Plus, Pencil, Trash2, Phone, Mail, User
} from 'lucide-react';

const MotionDiv = motion.div;

const DEFAULT_CONTACT = Object.freeze({ id: null, name: '', title: '', phone: '', email: '' });

const sanitizeContact = (c) => ({
  id: c?.id ?? null,
  name: (c?.name || '').trim(),
  title: (c?.title || '').trim(),
  phone: (c?.phone || '').trim(),
  email: (c?.email || '').trim().toLowerCase(),
});

const generateId = (contacts) => {
  if (!Array.isArray(contacts) || contacts.length === 0) return 1;
  return Math.max(...contacts.map(c => c?.id || 0)) + 1;
};

function ContactCard({ contact, onEdit, onDelete }) {
  return (
    <MotionDiv
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="group rounded-lg border border-[#3a424b] bg-[#282e35] p-3 text-white transition-all duration-200 hover:border-[#495057]"
    >
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#3a424b] bg-[#1d242c]">
            <User className="w-3.5 h-3.5 text-[#49b6d6]" />
          </div>
          <div>
            <p className="text-sm font-medium leading-tight">{contact.name || 'Unknown'}</p>
            {contact.title && (
              <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">{contact.title}</p>
            )}
          </div>
        </div>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onEdit(contact)} className="cursor-pointer rounded p-1 text-[#949494] hover:bg-[#1d242c] hover:text-white" title="Edit">
            <Pencil className="w-3 h-3" />
          </button>
          <button onClick={() => onDelete(contact.id)} className="cursor-pointer rounded p-1 hover:bg-[#ff5b57]/10" title="Delete">
            <Trash2 className="w-3 h-3 text-[#ff5b57]" />
          </button>
        </div>
      </div>

      <div className="ml-9 space-y-0.5">
        {contact.phone && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Phone className="w-3 h-3" />
            <span>{contact.phone}</span>
          </div>
        )}
        {contact.email && (
          <a
            href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(contact.email)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <Mail className="w-3 h-3" />
            <span>{contact.email}</span>
          </a>
        )}
      </div>
    </MotionDiv>
  );
}

export default function ContactsSidebar({ contacts, garageName, onUpdateContacts }) {
  const [isOpen, setIsOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [current, setCurrent] = useState({ ...DEFAULT_CONTACT });

  const safeContacts = useMemo(() =>
    Array.isArray(contacts) ? contacts.filter(c => c?.id != null) : [],
    [contacts]
  );

  const handleSave = useCallback(() => {
    const sanitized = sanitizeContact(current);
    if (!sanitized.name) return;
    let updated;
    if (isEditing && sanitized.id != null) {
      updated = safeContacts.map(c => c.id === sanitized.id ? sanitized : c);
    } else {
      updated = [...safeContacts, { ...sanitized, id: generateId(safeContacts) }];
    }
    onUpdateContacts?.(updated);
    setModalOpen(false);
    setCurrent({ ...DEFAULT_CONTACT });
  }, [current, isEditing, safeContacts, onUpdateContacts]);

  const [confirmDelete, setConfirmDelete] = useState(null);

  const handleDelete = useCallback((id) => {
    const c = safeContacts.find(c => c.id === id);
    setConfirmDelete({ message: `Delete contact "${c?.name || ''}"?`, action: () => onUpdateContacts?.(safeContacts.filter(c => c.id !== id)) });
  }, [onUpdateContacts, safeContacts]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex h-7 items-center gap-2 rounded-[5px] border border-[#495057] bg-transparent px-3 text-[11px] font-semibold text-white transition-colors hover:bg-[#282e35]"
        title={`Contacts for ${garageName}`}
      >
        <Users className="h-3.5 w-3.5 text-[#49b6d6]" />
        Contacts
        {safeContacts.length > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#348fe2] px-1 text-[9px] font-bold text-white">
            {safeContacts.length}
          </span>
        )}
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-xl border-[#3a424b] bg-[#1d242c] text-white">
          <DialogHeader>
            <div className="flex items-center justify-between gap-4 pr-6">
              <div>
                <DialogTitle className="flex items-center gap-2"><Users className="h-4 w-4 text-[#49b6d6]" /> Contacts</DialogTitle>
                <DialogDescription className="mt-1 text-[#949494]">{garageName} · {safeContacts.length} contact{safeContacts.length === 1 ? '' : 's'}</DialogDescription>
              </div>
              <Button
                type="button"
                onClick={() => {
                  setCurrent({ ...DEFAULT_CONTACT });
                  setIsEditing(false);
                  setModalOpen(true);
                }}
                className="h-[30px] rounded-[5px] bg-white px-3 text-[11px] font-bold text-[#151c23] hover:bg-[#e9ecef]"
              >
                <Plus className="h-3 w-3" /> Add Contact
              </Button>
            </div>
          </DialogHeader>
          <p className="rounded-[5px] border border-[#3a424b] bg-[#20272f] px-3 py-2 text-[10px] leading-snug text-[#949494]">
            Contacts are saved with the customer setup, not a sheet Contacts tab.
          </p>
          <ScrollArea className="max-h-[55vh] pr-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <AnimatePresence>
                {safeContacts.map(contact => (
                  <ContactCard
                    key={contact.id}
                    contact={contact}
                    onEdit={(c) => {
                      setCurrent(sanitizeContact(c));
                      setIsEditing(true);
                      setModalOpen(true);
                    }}
                    onDelete={handleDelete}
                  />
                ))}
              </AnimatePresence>
              {safeContacts.length === 0 && (
                <div className="col-span-full flex flex-col items-center gap-2 py-10 text-[#6c757d]">
                  <Users className="h-8 w-8 opacity-30" />
                  <p className="text-xs">No contacts yet</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Contact Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit Contact' : 'Add Contact'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name *</Label>
              <Input
                value={current.name}
                onChange={e => setCurrent(p => ({ ...p, name: e.target.value }))}
                placeholder="Contact name"
                className="mt-1.5"
              />
            </div>
            <div>
              <Label>Title</Label>
              <Input
                value={current.title}
                onChange={e => setCurrent(p => ({ ...p, title: e.target.value }))}
                placeholder="Job title"
                className="mt-1.5"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Phone</Label>
                <Input
                  value={current.phone}
                  onChange={e => setCurrent(p => ({ ...p, phone: e.target.value }))}
                  placeholder="(555) 555-5555"
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  value={current.email}
                  onChange={e => setCurrent(p => ({ ...p, email: e.target.value }))}
                  placeholder="email@example.com"
                  className="mt-1.5"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!current.name?.trim()}>
              {isEditing ? 'Save Changes' : 'Add Contact'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
            <DialogDescription>{confirmDelete?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { confirmDelete?.action(); setConfirmDelete(null); }}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
