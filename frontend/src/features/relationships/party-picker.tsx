"use client";
import { useEffect,useState } from 'react';
import { getClients,getClient,getContacts } from '../../shared/api/workbench';
import type { Client,Contact,PartySelection } from '../../shared/api/workbench';

export function PartyPicker({onChange,initialClient}:{onChange:(value:PartySelection|null)=>void;initialClient?:string}){
  const [clients,setClients]=useState<Client[]>([]),[client,setClient]=useState<Client|null>(null),[contacts,setContacts]=useState<Contact[]>([]);
  const [contact,setContact]=useState<Contact|null>(null),[clientOffset,setClientOffset]=useState(0),[contactOffset,setContactOffset]=useState(0),[clientTotal,setClientTotal]=useState(0),[contactTotal,setContactTotal]=useState(0),[error,setError]=useState('');
  useEffect(()=>{void getClients({limit:20,offset:clientOffset}).then(rows=>{setClients(rows.items);setClientTotal(rows.total);}).catch(e=>setError(e.message));},[clientOffset]);
  useEffect(()=>{if(initialClient)void getClient(initialClient).then(setClient).catch(e=>setError(e.message));},[initialClient]);
  useEffect(()=>{if(!client){setContacts([]);setContactTotal(0);return;}void getContacts(client.id,{limit:20,offset:contactOffset}).then(rows=>{setContacts(rows.items);setContactTotal(rows.total);}).catch(e=>setError(e.message));},[client?.id,contactOffset]);
  useEffect(()=>{onChange(client?{client_id:client.id,client_revision:client.revision,contact_id:contact?.id||null,contact_revision:contact?.revision||null}:null);},[client,contact,onChange]);
  return <fieldset><legend>客戶／聯絡人（可不指定）</legend>{error&&<p role="alert">{error}</p>}
    <label>關聯客戶<select aria-label="關聯客戶" value={client?.id||''} onChange={e=>{setClient(clients.find(r=>r.id===e.target.value)||null);setContact(null);setContactOffset(0);}}><option value="">不指定</option>{client&&!clients.some(r=>r.id===client.id)&&<option value={client.id}>{client.name}</option>}{clients.map(row=><option key={row.id} value={row.id}>{row.name}{row.archived_at?'（已封存）':''}</option>)}</select></label>
    <div className="actions"><button type="button" disabled={!clientOffset} onClick={()=>setClientOffset(Math.max(0,clientOffset-20))}>上一頁客戶選項</button><button type="button" disabled={clientOffset+20>=clientTotal} onClick={()=>setClientOffset(clientOffset+20)}>下一頁客戶選項</button></div>
    {client&&<><label>關聯聯絡人<select aria-label="關聯聯絡人" value={contact?.id||''} onChange={e=>setContact(contacts.find(r=>r.id===e.target.value)||null)}><option value="">不指定</option>{contact&&!contacts.some(r=>r.id===contact.id)&&<option value={contact.id}>{contact.name}</option>}{contacts.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><div className="actions"><button type="button" disabled={!contactOffset} onClick={()=>setContactOffset(Math.max(0,contactOffset-20))}>上一頁聯絡人選項</button><button type="button" disabled={contactOffset+20>=contactTotal} onClick={()=>setContactOffset(contactOffset+20)}>下一頁聯絡人選項</button></div></>}
  </fieldset>;
}
