"use client";
import { useEffect,useState } from 'react';
import { getApplicationSummary } from '../../shared/api/client';
import type { ApplicationSummary } from '../../shared/api/client';
import './workbench.css';

export function WorkNavigation(){
  const [summary,setSummary]=useState<ApplicationSummary|null>(null);
  useEffect(()=>{const refresh=()=>void getApplicationSummary().then(setSummary).catch(()=>setSummary(null));refresh();window.addEventListener('focus',refresh);const timer=setInterval(refresh,60000);return()=>{window.removeEventListener('focus',refresh);clearInterval(timer);};},[]);
  return <nav className="workbench-navigation" aria-label="工作台導覽"><a href="/">探索機會</a><a href="/applications">投案紀錄</a><a href="/clients">客戶與聯絡人</a><a href="/proposals">提案草稿</a><a href="/submissions">外部送出</a><a href="/applications?due=1">待跟進{summary?` ${summary.due_count}（逾期 ${summary.overdue_count}）`:' · 尚未取得統計'}</a></nav>;
}
