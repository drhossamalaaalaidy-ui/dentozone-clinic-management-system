import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ClerkProvider, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useGetSession } from '@workspace/api-client-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { LocaleProvider, useLocale } from '@/lib/locale';
import { AuthActionsProvider } from '@/lib/auth-actions';
import { Protected, State } from '@/components/clinic-ui';
import Dashboard from '@/pages/dashboard';
import Patients from '@/pages/patients';
import PatientProfile from '@/pages/patient-profile';
import Settings from '@/pages/settings';
import FinanceInvoices from '@/pages/finance-invoices';
import FinanceInvoiceDetail from '@/pages/finance-invoice-detail';
import FinanceExpenses from '@/pages/finance-expenses';
import FinanceSuppliers from '@/pages/finance-suppliers';
import FinanceReports from '@/pages/finance-reports';
import Inventory from '@/pages/inventory';
import Appointments, { AppointmentDetail } from '@/pages/appointments';
import PatientClinical from '@/pages/patient-clinical';
import VisitPage from '@/pages/visit';
import TreatmentPlanPage from '@/pages/treatment-plan';
import PatientDocuments from '@/pages/patient-documents';
import PatientOrthodontics, { OrthodonticCaseDetail } from '@/pages/patient-orthodontics';
import PatientLaboratory from '@/pages/patient-laboratory';
import PatientAligners from '@/pages/patient-aligners';
import PatientPrescriptions from '@/pages/patient-prescriptions';
import Marketing from '@/pages/marketing';
import PatientReminderPreferences from '@/pages/patient-reminder-preferences';
import Reminders from '@/pages/reminders';
import OperationalReports from '@/pages/operational-reports';
import { AuthPage, Home } from '@/pages/public';
import './responsive.css';
import './home-responsive.css';

const queryClient = new QueryClient({defaultOptions:{queries:{retry:1,staleTime:15000}}});
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
type AuthProvider = 'clerk' | 'oidc';
const AuthProviderContext = createContext<AuthProvider>('clerk');
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}
const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#236b70',
    colorForeground: '#193f46',
    colorMutedForeground: '#5d797a',
    colorDanger: '#ad4a41',
    colorBackground: '#fffefa',
    colorInput: '#f6f8f3',
    colorInputForeground: '#193f46',
    colorNeutral: '#cddbd6',
    fontFamily: '"DM Sans", "Noto Sans Arabic", sans-serif',
    borderRadius: '12px',
  },
  elements: {
    rootBox: 'w-full max-w-full min-w-0 flex justify-center',
    cardBox: 'bg-[#fffefa] rounded-[20px] w-[calc(100vw-40px)] sm:w-[440px] max-w-full min-w-0 overflow-hidden border border-[#e1e9e1]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none min-w-0 max-w-full',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#193f46] font-bold',
    headerSubtitle: 'text-[#5d797a]',
    socialButtonsBlockButtonText: 'text-[#193f46] font-semibold',
    formFieldLabel: 'text-[#31575a] font-semibold',
    footerActionLink: 'text-[#236b70] font-bold',
    footerActionText: 'text-[#5d797a]',
    dividerText: 'text-[#5d797a]',
    identityPreviewEditButton: 'text-[#236b70]',
    formFieldSuccessText: 'text-[#236b70]',
    alertText: 'text-[#ad4a41]',
    logoBox: 'justify-start',
    logoImage: 'h-9',
    socialButtonsBlockButton: 'border border-[#d7e3dd] bg-[#fffefa] text-[#193f46]',
    formButtonPrimary: 'bg-[#236b70] text-[#fffefa] font-bold',
    formFieldInput: 'bg-[#f6f8f3] border border-[#d7e3dd] text-[#193f46]',
    footerAction: 'bg-transparent',
    dividerLine: 'bg-[#d7e3dd]',
    alert: 'bg-[#fff1ed]',
    otpCodeFieldInput: 'bg-[#f6f8f3] text-[#193f46]',
    formFieldRow: 'gap-2',
    main: 'gap-4 min-w-0 max-w-full',
    form: 'min-w-0 max-w-full',
  },
};
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) client.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, client]);
  return null;
}
function HomeRedirect(){const provider=useContext(AuthProviderContext);return provider==='oidc'?<OidcHomeRedirect/>:<><Show when="signed-in"><Redirect to="/dashboard"/></Show><Show when="signed-out"><Home/></Show></>}
function OidcHomeRedirect(){const q=useGetSession();return q.data?<Redirect to="/dashboard"/>:<Home/>}
function Authenticated({children}:{children:React.ReactNode}){const provider=useContext(AuthProviderContext);if(provider==='oidc')return <OidcAuthenticated>{children}</OidcAuthenticated>;return <><Show when="signed-in">{children}</Show><Show when="signed-out"><Redirect to="/"/></Show></>}
function OidcAuthenticated({children}:{children:React.ReactNode}){const q=useGetSession();if(q.isLoading)return <div className="page"><State kind="loading"/></div>;if(q.error&&(q.error as {status?:number}).status===401)return <Redirect to="/sign-in"/>;return <>{children}</>}
function NotFound(){const {language}=useLocale();return <div style={{minHeight:'100dvh',display:'grid',placeItems:'center',padding:24}}><div style={{width:'min(100%,450px)'}}><State kind="empty" title="404" description={language==='ar'?'الصفحة غير موجودة.':'This page could not be found.'}/><div style={{textAlign:'center',marginTop:17}}><Link href="/" className="btn btn-primary" data-testid="link-not-found-home">{language==='ar'?'العودة للرئيسية':'Back home'}</Link></div></div></div>}
function Routes(){
  const provider=useContext(AuthProviderContext);
  return <Switch>
    <Route path="/" component={HomeRedirect}/>
    <Route path="/sign-in/*?"><AuthPage mode="in" provider={provider}/></Route>
    <Route path="/sign-up/*?"><AuthPage mode="up" provider={provider}/></Route>
    <Route path="/dashboard"><Authenticated><Protected>{session=><Dashboard session={session}/>}</Protected></Authenticated></Route>
    <Route path="/appointments"><Authenticated><Protected allow={['owner','manager','reception','dentist','assistant']}>{session=><Appointments session={session}/>}</Protected></Authenticated></Route>
    <Route path="/appointments/:id"><Authenticated><Protected allow={['owner','manager','reception','dentist','assistant']}>{session=><AppointmentDetail session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients"><Authenticated><Protected allow={['owner','manager','dentist','reception','assistant']}>{session=><Patients session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id/clinical"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><PatientClinical session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id/documents"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><PatientDocuments session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id/orthodontics"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><PatientOrthodontics session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id/laboratory"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><PatientLaboratory session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id/aligners"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><PatientAligners session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id/prescriptions"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><PatientPrescriptions session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id/reminder-preferences"><Authenticated><Protected allow={['owner','manager','reception','dentist']}>{session=><PatientReminderPreferences session={session}/>}</Protected></Authenticated></Route>
    <Route path="/patients/:id"><Authenticated><Protected allow={['owner','manager','dentist','reception','assistant']}>{session=><PatientProfile session={session}/>}</Protected></Authenticated></Route>
    <Route path="/orthodontic-cases/:id"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><OrthodonticCaseDetail session={session}/>}</Protected></Authenticated></Route>
    <Route path="/visits/:id"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><VisitPage session={session}/>}</Protected></Authenticated></Route>
    <Route path="/treatment-plans/:id"><Authenticated><Protected allow={['owner','manager','dentist','assistant']}>{session=><TreatmentPlanPage session={session}/>}</Protected></Authenticated></Route>
    <Route path="/reminders"><Authenticated><Protected allow={['owner','manager','reception','dentist']}>{session=><Reminders session={session}/>}</Protected></Authenticated></Route>
    <Route path="/clinic/reports"><Authenticated><Protected allow={['owner','manager']}>{()=><OperationalReports/>}</Protected></Authenticated></Route>
    <Route path="/marketing"><Authenticated><Protected allow={['owner','manager']}>{session=><Marketing session={session}/>}</Protected></Authenticated></Route>
    <Route path="/finance"><Authenticated><Protected allow={['owner','manager','accountant']}>{()=><FinanceInvoices/>}</Protected></Authenticated></Route>
    <Route path="/finance/invoices/:id"><Authenticated><Protected allow={['owner','manager','accountant']}>{()=><FinanceInvoiceDetail/>}</Protected></Authenticated></Route>
    <Route path="/finance/expenses"><Authenticated><Protected allow={['owner','manager','accountant']}>{()=><FinanceExpenses/>}</Protected></Authenticated></Route>
    <Route path="/finance/suppliers"><Authenticated><Protected allow={['owner','manager','accountant']}>{()=><FinanceSuppliers/>}</Protected></Authenticated></Route>
    <Route path="/finance/reports"><Authenticated><Protected allow={['owner','manager','accountant']}>{()=><FinanceReports/>}</Protected></Authenticated></Route>
    <Route path="/inventory"><Authenticated><Protected allow={['owner','manager','accountant','dentist','assistant']}>{session=><Inventory session={session}/>}</Protected></Authenticated></Route>
    <Route path="/settings"><Authenticated><Protected>{session=><Settings session={session}/>}</Protected></Authenticated></Route>
    <Route component={NotFound}/>
  </Switch>;
}
function ClerkContent(){
  const client = useQueryClient();
  const clerkActions = useClerk();
  return <AuthActionsProvider signOut={()=>{client.clear();void clerkActions.signOut({redirectUrl:basePath||'/'});}}><ClerkQueryClientCacheInvalidator/><LocaleProvider><AuthProviderContext.Provider value="clerk"><Routes/></AuthProviderContext.Provider></LocaleProvider></AuthActionsProvider>;
}
function ClerkProviderWithRoutes(){
  const [, setLocation] = useLocation();
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY for AUTH_PROVIDER=clerk');
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{
      signIn:{start:{title:'Welcome back',subtitle:'Sign in to your clinic workspace'}},
      signUp:{start:{title:'Create your account',subtitle:'Join your clinic workspace'}},
    }}
    routerPush={(to)=>setLocation(stripBase(to))}
    routerReplace={(to)=>setLocation(stripBase(to),{replace:true})}
  ><ClerkContent/></ClerkProvider>
}
function OidcProviderWithRoutes(){
  const signOut=async()=>{
    try {
      const csrf=document.cookie.split('; ').find(cookie=>cookie.startsWith('dentozone_csrf='))?.slice('dentozone_csrf='.length);
      const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json',...(csrf?{'x-csrf-token':decodeURIComponent(csrf)}:{})},body:'{}'});
      if(!response.ok)throw new Error('Sign out failed');
      const data=await response.json() as {redirectUrl:string};
      if(!data.redirectUrl)throw new Error('Identity sign out URL is unavailable');
      queryClient.clear();
      window.location.assign(data.redirectUrl);
    } catch {
      window.alert('Sign out could not be completed. Please try again.');
    }
  };
  return <AuthActionsProvider signOut={()=>{void signOut();}}><LocaleProvider><AuthProviderContext.Provider value="oidc"><Routes/></AuthProviderContext.Provider></LocaleProvider></AuthActionsProvider>
}
function AuthenticatedApp({provider}:{provider:AuthProvider}){
  return <QueryClientProvider client={queryClient}>{provider==='oidc'?<OidcProviderWithRoutes/>:<ClerkProviderWithRoutes/>}</QueryClientProvider>;
}
function App(){
  const [provider,setProvider]=useState<AuthProvider|null>(null);
  const [configError,setConfigError]=useState<string|null>(null);
  useEffect(()=>{
    fetch('/api/auth/config',{credentials:'same-origin',cache:'no-store'})
      .then(async response=>{
        if(!response.ok)throw new Error(`Authentication configuration request failed (${response.status})`);
        const config=await response.json() as {provider?:string};
        if(config.provider!=='oidc'&&config.provider!=='clerk')throw new Error('The server returned an unsupported authentication provider');
        setProvider(config.provider);
      })
      .catch(error=>setConfigError(error instanceof Error?error.message:'Authentication configuration could not be loaded'));
  },[]);
  return <WouterRouter base={basePath}>{provider?<AuthenticatedApp provider={provider}/>:configError?<div role="alert" style={{padding:24,color:'#a63e36'}}>{configError}. Reload the page to try again.</div>:<div className="page"><State kind="loading" description="Loading authentication configuration"/></div>}</WouterRouter>
}
export default App;