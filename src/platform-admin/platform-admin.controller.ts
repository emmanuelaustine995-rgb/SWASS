import { BadRequestException, Controller, Get, Param, Post, Query, UseGuards, NotFoundException, Req } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHmac, randomBytes } from 'node:crypto';
import { AuthGuard, Roles, RolesGuard } from '../auth/auth';
import { DbService } from '../db/db.service';

@Controller('api/v1/platform-admin')
@UseGuards(AuthGuard, RolesGuard)
@Roles('super_admin')
export class PlatformAdminController {
  constructor(private db: DbService) {}

  // Administrators can create any supported account directly; public OTP signup is not required here.
  @Post('accounts/create')
  async createAccount(@Req() req: any, @Body() body: any) {
    const accountType = String(body?.accountType || '').trim().toLowerCase();
    const fullName = String(body?.fullName || '').trim();
    const email = String(body?.email || '').trim().toLowerCase() || null;
    const rawPhone = String(body?.phone || '').trim();
    let digits = rawPhone.replace(/\\D/g, '');
    if (digits.startsWith('254')) digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!/^[17]\\d{8}$/.test(digits)) throw new BadRequestException('Enter a valid Kenyan phone number.');
    const phone = '254' + digits;
    const password = String(body?.password || '');
    if (!fullName || fullName.length > 120) throw new BadRequestException('Enter a valid full name.');
    if (email && (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || email.length > 254)) throw new BadRequestException('Enter a valid email address.');
    if (password.length < 10 || password.length > 128) throw new BadRequestException('Set a password of at least 10 characters.');
    const passwordHash = await argon2.hash(password);
    const normalize = (value: unknown) => { let d = String(value || '').replace(/\\D/g, ''); if (d.startsWith('254')) d=d.slice(3); if (d.startsWith('0')) d=d.slice(1); return /^[17]\\d{8}$/.test(d) ? '254'+d : ''; };
    const secret = process.env.SWASS_ID_SECRET;
    const created = await this.db.tx(async client => {
      if (accountType === 'customer') {
        const nationalId = String(body?.nationalId || '').replace(/\\s+/g, '');
        if (!/^[0-9]{7,9}$/.test(nationalId)) throw new BadRequestException('Enter a valid customer National ID number.');
        if (!secret) throw new BadRequestException('Secure identity verification is not configured.');
        const nationalIdHash = createHmac('sha256', secret).update('aurora-customer-national-id:' + nationalId).digest('hex');
        const duplicate = await client.query('SELECT 1 FROM customer_accounts WHERE is_active=true AND (phone=$1 OR lower(coalesce(email,\'\'))=lower(coalesce($2,\'\')) OR national_id_hash=$3) LIMIT 1', [phone,email,nationalIdHash]);
        if (duplicate.rowCount) throw new BadRequestException('An active customer already uses this phone, email or National ID.');
        const result = await client.query(
          'INSERT INTO customer_accounts(full_name,phone,email,password_hash,referral_code,national_id_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,full_name,phone,email',
          [fullName,phone,email,passwordHash,randomBytes(6).toString('hex').toUpperCase(),nationalIdHash],
        );
        return { id: result.rows[0].id, accountType, fullName, phone, email };
      }
      if (accountType === 'shop_owner') {
        const businessName=String(body?.businessName||'').trim();
        const storeName=String(body?.storeName||businessName).trim();
        const storeLocation=String(body?.storeLocation||'').trim();
        const nationalId=String(body?.nationalId||'').replace(/\\s+/g,'');
        const idPhotoData=String(body?.idPhotoData||'');
        const passportPhotoData=String(body?.passportPhotoData||'');
        if(!businessName||businessName.length>160||!storeName||storeName.length>160||!storeLocation||storeLocation.length>200) throw new BadRequestException('Enter the business name, shop name and location.');
        if(!/^[0-9]{7,9}$/.test(nationalId)||!secret) throw new BadRequestException('Enter a valid National ID and ensure identity security is configured.');
        const validImage=(v:string)=>!v||(/^data:image\\/(jpeg|png|webp);base64,/.test(v)&&v.length<=2800000);
        if(!validImage(idPhotoData)||!validImage(passportPhotoData)) throw new BadRequestException('ID and passport photos must be JPG, PNG or WebP images no larger than 2 MB each.');
        const nationalIdHash=createHmac('sha256',secret).update('aurora-owner-national-id:'+nationalId).digest('hex');
        const duplicate=await client.query(
          `SELECT 1 FROM users u LEFT JOIN aurora_owner_identity_records r ON r.user_id=u.id
            WHERE u.is_active=true AND (u.phone IN ($1,$2) OR lower(coalesce(u.email,''))=lower(coalesce($3,'')) OR r.national_id_hash=$4) LIMIT 1`,
          [phone,'0'+phone.slice(3),email,nationalIdHash]);
        if(duplicate.rowCount) throw new BadRequestException('An active account already uses this phone, email or National ID.');
        const tenant=await client.query('INSERT INTO tenants(name,phone,email,website_url,kra_pin,legal_name) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
          [businessName,phone,email,String(body?.websiteUrl||'').trim()||null,String(body?.kraPin||'').trim()||null,String(body?.legalName||'').trim()||businessName]);
        const store=await client.query('INSERT INTO stores(tenant_id,name,location) VALUES($1,$2,$3) RETURNING id',[tenant.rows[0].id,storeName,storeLocation]);
        const user=await client.query("INSERT INTO users(tenant_id,store_id,full_name,phone,email,password_hash,role) VALUES($1,$2,$3,$4,$5,$6,'owner') RETURNING id",[tenant.rows[0].id,store.rows[0].id,fullName,phone,email,passwordHash]);
        await client.query('INSERT INTO aurora_owner_identity_records(user_id,national_id_hash,id_photo_data,passport_photo_data) VALUES($1,$2,$3,$4)',[user.rows[0].id,nationalIdHash,idPhotoData||null,passportPhotoData||null]);
        await client.query('INSERT INTO wallets(tenant_id) VALUES($1) ON CONFLICT(tenant_id) DO NOTHING',[tenant.rows[0].id]);
        return {id:user.rows[0].id,accountType,fullName,phone,email,tenantId:tenant.rows[0].id,storeId:store.rows[0].id};
      }
      if (accountType === 'freelancer') {
        const ownerPhone=normalize(body?.ownerPhone);
        const nationalId=String(body?.nationalId||'').replace(/\\s+/g,'');
        const idPhotoData=String(body?.idPhotoData||'');
        const profilePhotoData=String(body?.profilePhotoData||'');
        if(!ownerPhone) throw new BadRequestException('Enter the registered shop-owner phone number to link this freelancer.');
        if(!/^[0-9]{6,12}$/.test(nationalId)||!secret) throw new BadRequestException('Enter a valid National ID and ensure identity security is configured.');
        const validImage=(v:string)=>/^data:image\\/(jpeg|png|webp);base64,/.test(v)&&v.length<=2800000;
        if(!validImage(idPhotoData)||!validImage(profilePhotoData)) throw new BadRequestException('Upload valid ID and profile photos (JPG, PNG or WebP; maximum 2 MB).');
        const owner=await client.query(
          `SELECT u.id,u.tenant_id,u.store_id FROM users u JOIN tenants t ON t.id=u.tenant_id
            WHERE u.role='owner' AND u.is_active=true AND COALESCE(t.status,'active')='active' AND u.store_id IS NOT NULL
              AND regexp_replace(coalesce(u.phone,''),'[^0-9]','','g')=ANY($1::text[]) LIMIT 2`,
          [[ownerPhone,'0'+ownerPhone.slice(3),ownerPhone.slice(3)]]);
        if(!owner.rowCount) throw new BadRequestException('No active shop owner was found with that phone number.');
        if(owner.rowCount>1) throw new BadRequestException('That phone number matches more than one shop. Contact support to resolve the link.');
        const duplicate=await client.query("SELECT 1 FROM users WHERE is_active=true AND (phone IN ($1,$2) OR lower(coalesce(email,''))=lower(coalesce($3,''))) LIMIT 1",[phone,'0'+phone.slice(3),email]);
        if(duplicate.rowCount) throw new BadRequestException('An active account already uses this phone or email.');
        const user=await client.query(
          `INSERT INTO users(tenant_id,store_id,full_name,phone,email,password_hash,role,must_change_password,staff_title,profile_photo_data,national_id_number,national_id_photo_data)
           VALUES($1,$2,$3,$4,$5,$6,'freelancer',false,'Freelancer',$7,$8,$9) RETURNING id`,
          [owner.rows[0].tenant_id,owner.rows[0].store_id,fullName,phone,email,passwordHash,profilePhotoData,nationalId,idPhotoData]);
        return {id:user.rows[0].id,accountType,fullName,phone,email,tenantId:owner.rows[0].tenant_id};
      }
      if (accountType === 'staff') {
        const tenantId=String(body?.tenantId||'').trim();
        const storeId=String(body?.storeId||'').trim();
        const staffRole=String(body?.staffRole||'cashier').trim().toLowerCase();
        if(!tenantId||!storeId||!['cashier','vendor','manager'].includes(staffRole)) throw new BadRequestException('Choose a valid shop and staff role (cashier, vendor or manager).');
        const shop=await client.query('SELECT 1 FROM stores WHERE id=$1 AND tenant_id=$2 LIMIT 1',[storeId,tenantId]);
        if(!shop.rowCount) throw new BadRequestException('The selected store does not belong to the selected shop.');
        const duplicate=await client.query("SELECT 1 FROM users WHERE is_active=true AND (phone IN ($1,$2) OR lower(coalesce(email,''))=lower(coalesce($3,''))) LIMIT 1",[phone,'0'+phone.slice(3),email]);
        if(duplicate.rowCount) throw new BadRequestException('An active account already uses this phone or email.');
        const user=await client.query('INSERT INTO users(tenant_id,store_id,full_name,phone,email,password_hash,role,staff_title) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
          [tenantId,storeId,fullName,phone,email,passwordHash,staffRole,String(body?.staffTitle||staffRole).slice(0,80)]);
        return {id:user.rows[0].id,accountType,fullName,phone,email,tenantId,storeId,staffRole};
      }
      throw new BadRequestException('Choose Shop owner, Freelancer, Customer or Staff.');
    });
    try {
      await this.db.recordSecurityEvent({eventType:'admin_account_created',severity:'medium',outcome:'completed',actorUserId:req.user?.sub,sourceIp:req.ip,userAgent:req.headers?.['user-agent'],metadata:{accountId:created.id,accountType:created.accountType,tenantId:(created as any).tenantId||null}});
    } catch (error) { console.error('[AURORA_ADMIN] Account created but audit logging failed:',error instanceof Error?error.message:error); }
    return {created:true,account:created,message:'Account created by an authorised administrator. Public OTP registration was not required.'};
  }

  @Get('overview')
  async overview() {
    const [shops, stores, users, customers, receipts, subscriptions] = await Promise.all([
      this.db.pool.query('SELECT COUNT(*)::int AS count FROM tenants'),
      this.db.pool.query('SELECT COUNT(*)::int AS count FROM stores'),
      this.db.pool.query(`SELECT
        COUNT(*) FILTER (WHERE role='owner' AND is_active=true)::int AS owners,
        COUNT(*) FILTER (WHERE role='freelancer' AND is_active=true)::int AS freelancers,
        COUNT(*) FILTER (WHERE is_active=false)::int AS inactive
        FROM users`),
      this.db.pool.query('SELECT COUNT(*) FILTER (WHERE is_active=true)::int AS active FROM customer_accounts'),
      this.db.pool.query(`SELECT COUNT(*)::int AS count FROM receipts WHERE status='issued'`),
      this.db.pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='active' AND ends_at>now())::int AS active,
        COUNT(*) FILTER (WHERE status<>'active' OR ends_at<=now())::int AS inactive
        FROM subscriptions`),
    ]);
    return {
      shops: Number(shops.rows[0].count),
      stores: Number(stores.rows[0].count),
      activeOwners: Number(users.rows[0].owners),
      activeFreelancers: Number(users.rows[0].freelancers),
      activeCustomers: Number(customers.rows[0].active),
      inactiveUsers: Number(users.rows[0].inactive),
      issuedReceipts: Number(receipts.rows[0].count),
      activeSubscriptions: Number(subscriptions.rows[0].active),
      inactiveSubscriptions: Number(subscriptions.rows[0].inactive),
    };
  }


  @Get('reports')
  async platformReports(@Query('from') from = '', @Query('to') to = '') {
    const validDate = (value: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(value + 'T00:00:00Z'); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; };
    const endDate = validDate(to) ? to : new Date().toISOString().slice(0, 10);
    const startDate = validDate(from) ? from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    if (startDate > endDate) throw new BadRequestException('The report start date must be on or before the end date.');
    const span = (Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000;
    if (span > 365) throw new BadRequestException('Choose a reporting period of 366 days or less.');
    const params = [startDate, endDate];
    const [shops, users, receipts, subscriptions, ledger, daily, paymentMethods, topShops] = await Promise.all([
      this.db.pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='active')::int AS active,
        COUNT(*) FILTER (WHERE status='suspended')::int AS suspended,
        COUNT(*) FILTER (WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day')::int AS new_in_period
        FROM tenants`, params),
      this.db.pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active=true)::int AS active,
        COUNT(*) FILTER (WHERE is_active=false)::int AS inactive,
        COUNT(*) FILTER (WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day')::int AS new_in_period
        FROM users WHERE role <> 'super_admin'`, params),
      this.db.pool.query(`SELECT COUNT(*) FILTER (WHERE status='issued')::int AS issued,
        COUNT(*) FILTER (WHERE status='voided')::int AS voided,
        COUNT(*) FILTER (WHERE status='returned')::int AS returned,
        COALESCE(SUM(total_kes) FILTER (WHERE status='issued'),0)::bigint AS issued_value_kes,
        COUNT(*) FILTER (WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day' AND status='issued')::int AS issued_in_period,
        COALESCE(SUM(total_kes) FILTER (WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day' AND status='issued'),0)::bigint AS issued_value_in_period_kes
        FROM receipts WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day'`, params),
      this.db.pool.query(`SELECT COUNT(*) FILTER (WHERE starts_at >= $1::date AND starts_at < $2::date + interval '1 day')::int AS started_in_period,
        COUNT(*) FILTER (WHERE status='active' AND starts_at<=now() AND ends_at>now())::int AS active_now,
        COUNT(*) FILTER (WHERE ends_at >= $1::date AND ends_at < $2::date + interval '1 day')::int AS ending_in_period
        FROM subscriptions`, params),
      this.db.pool.query(`SELECT
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='subscription_revenue'),0)::bigint AS subscription_kes,
        COALESCE(SUM(amount_kes) FILTER (WHERE entry_type='receipt_fee_revenue'),0)::bigint AS receipt_fee_kes,
        COALESCE(SUM(amount_kes),0)::bigint AS total_kes, COUNT(*)::int AS entries
        FROM platform_financial_ledger WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day'`, params),
      this.db.pool.query(`WITH days AS (
          SELECT generate_series($1::date,$2::date,interval '1 day')::date AS day
        ), r AS (
          SELECT issued_at::date AS day, COUNT(*) FILTER (WHERE status='issued')::int AS receipts,
                 COALESCE(SUM(total_kes) FILTER (WHERE status='issued'),0)::bigint AS sales_kes
          FROM receipts WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day' GROUP BY issued_at::date
        ), u AS (
          SELECT created_at::date AS day, COUNT(*)::int AS registrations
          FROM users WHERE role <> 'super_admin' AND created_at >= $1::date AND created_at < $2::date + interval '1 day' GROUP BY created_at::date
        ), t AS (
          SELECT created_at::date AS day, COUNT(*)::int AS new_shops
          FROM tenants WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day' GROUP BY created_at::date
        )
        SELECT days.day, COALESCE(r.receipts,0)::int AS receipts, COALESCE(r.sales_kes,0)::bigint AS "salesKes",
               COALESCE(u.registrations,0)::int AS registrations, COALESCE(t.new_shops,0)::int AS "newShops"
        FROM days LEFT JOIN r USING(day) LEFT JOIN u USING(day) LEFT JOIN t USING(day) ORDER BY days.day`, params),
      this.db.pool.query(`SELECT payment_method AS "paymentMethod", COUNT(*) FILTER (WHERE status='issued')::int AS receipts,
        COALESCE(SUM(total_kes) FILTER (WHERE status='issued'),0)::bigint AS "salesKes"
        FROM receipts WHERE issued_at >= $1::date AND issued_at < $2::date + interval '1 day'
        GROUP BY payment_method ORDER BY payment_method`, params),
      this.db.pool.query(`SELECT t.name AS "businessName", COUNT(r.id) FILTER (WHERE r.status='issued')::int AS receipts,
        COALESCE(SUM(r.total_kes) FILTER (WHERE r.status='issued'),0)::bigint AS "salesKes"
        FROM tenants t LEFT JOIN receipts r ON r.tenant_id=t.id
          AND r.issued_at >= $1::date AND r.issued_at < $2::date + interval '1 day'
        GROUP BY t.id,t.name ORDER BY "salesKes" DESC, receipts DESC LIMIT 10`, params),
    ]);
    return {
      period: { from: startDate, to: endDate },
      shops: shops.rows[0], users: users.rows[0], receipts: receipts.rows[0],
      subscriptions: subscriptions.rows[0], platformRevenue: ledger.rows[0],
      daily: daily.rows, paymentMethods: paymentMethods.rows, topShops: topShops.rows,
      definitions: { shopSalesAreNotPlatformRevenue: true, receiptSalesAreGrossIssuedReceiptValue: true, platformRevenueIsLedgerOnly: true },
      generatedAt: new Date().toISOString(),
    };
  }

  @Get('shops')
  async shopDirectory(@Query('search') search = '', @Query('limit') limit = '50') {
    const term = String(search || '').trim().slice(0, 100);
    const take = Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 100) throw new BadRequestException('limit must be from 1 to 100');
    const result = await this.db.pool.query(
      `SELECT t.id AS "tenantId",t.name AS "businessName",t.phone AS "businessPhone",
              t.email AS "businessEmail",s.id AS "storeId",s.name AS "storeName",
              s.location AS "storeLocation",
              (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id=t.id AND u.is_active=true) AS "activeUsers",
              (SELECT COUNT(*)::int FROM receipts r WHERE r.tenant_id=t.id AND r.status='issued') AS "issuedReceipts",
              (SELECT sub.status FROM subscriptions sub WHERE sub.tenant_id=t.id ORDER BY sub.ends_at DESC LIMIT 1) AS "subscriptionStatus",
              (SELECT sub.ends_at FROM subscriptions sub WHERE sub.tenant_id=t.id ORDER BY sub.ends_at DESC LIMIT 1) AS "subscriptionEndsAt"
         FROM tenants t
         LEFT JOIN LATERAL (
           SELECT st.id,st.name,st.location FROM stores st WHERE st.tenant_id=t.id ORDER BY st.name LIMIT 1
         ) s ON true
        WHERE ($1='' OR t.name ILIKE '%'||$1||'%' OR COALESCE(t.phone,'') ILIKE '%'||$1||'%' OR COALESCE(t.email,'') ILIKE '%'||$1||'%')
        ORDER BY t.name ASC LIMIT $2`,
      [term, take],
    );
    return { shops: result.rows };
  }

  @Get('people')
  async peopleDirectory(@Query('search') search = '', @Query('limit') limit = '100') {
    const term = String(search || '').trim().slice(0, 100);
    const take = Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 200) throw new BadRequestException('limit must be from 1 to 200');
    const result = await this.db.pool.query(
      `SELECT u.id,u.full_name AS "fullName",u.phone,u.email,u.role,u.is_active AS "isActive",
              u.created_at AS "createdAt",t.name AS "businessName"
         FROM users u
         LEFT JOIN tenants t ON t.id=u.tenant_id
        WHERE u.role IN ('owner','manager','freelancer')
          AND ($1='' OR u.full_name ILIKE '%'||$1||'%' OR COALESCE(u.phone,'') ILIKE '%'||$1||'%' OR COALESCE(u.email,'') ILIKE '%'||$1||'%' OR COALESCE(t.name,'') ILIKE '%'||$1||'%')
        ORDER BY u.created_at DESC LIMIT $2`,
      [term, take],
    );
    return { people: result.rows };
  }

  @Get('security/summary')
  async securitySummary() {
    await this.db.ensureSecuritySchema();
    const result = await this.db.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours')::int AS events_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND severity='critical')::int AS critical_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND severity='high')::int AS high_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND event_type IN ('login_failed','admin_login_failed'))::int AS failed_logins_24h,
        COUNT(DISTINCT source_ip) FILTER (WHERE created_at >= now()-interval '24 hours' AND outcome='blocked')::int AS blocked_sources_24h,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '7 days' AND event_type='shop_deactivated')::int AS shops_deactivated_7d,
        COUNT(*) FILTER (WHERE created_at >= now()-interval '24 hours' AND event_type='admin_login_success')::int AS admin_logins_24h
      FROM aurora_security_events
    `);
    const open = await this.db.pool.query(`
      SELECT COUNT(*)::int AS count FROM aurora_security_events
       WHERE severity IN ('critical','high') AND outcome IN ('detected','blocked')
         AND created_at >= now()-interval '7 days'
    `);
    return { ...result.rows[0], openHighPriority: Number(open.rows[0].count), monitoring: 'event-log' };
  }

  @Get('security/events')
  async securityEvents(@Query('limit') limit = '50', @Query('severity') severity = '') {
    await this.db.ensureSecuritySchema();
    const take = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 50));
    const validSeverity = ['critical','high','medium','low','info'].includes(severity) ? severity : '';
    const result = await this.db.pool.query(`
      SELECT id,event_type AS "eventType",severity,outcome,actor_user_id AS "actorUserId",source_ip AS "sourceIp",
             user_agent AS "userAgent",metadata,created_at AS "createdAt"
        FROM aurora_security_events
       WHERE ($1='' OR severity=$1)
       ORDER BY created_at DESC LIMIT $2
    `, [validSeverity, take]);
    return { events: result.rows };
  }

  @Get('security/trends')
  async securityTrends() {
    await this.db.ensureSecuritySchema();
    const result = await this.db.pool.query(`
      SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24:00:00') AS hour,
             COUNT(*)::int AS events,
             COUNT(*) FILTER (WHERE severity IN ('critical','high'))::int AS high_priority,
             COUNT(*) FILTER (WHERE event_type IN ('login_failed','admin_login_failed'))::int AS failed_logins
        FROM aurora_security_events
       WHERE created_at >= now()-interval '24 hours'
       GROUP BY date_trunc('hour', created_at)
       ORDER BY date_trunc('hour', created_at)
    `);
    return { points: result.rows };
  }

  @Get('system/status')
  async systemStatus() {
    const checks: Array<{ key: string; label: string; status: 'ready' | 'attention' | 'unknown'; detail: string }> = [];
    const configured = (key: string, minLength = 1) => Boolean(process.env[key] && process.env[key]!.length >= minLength);
    checks.push({
      key: 'database-config', label: 'Database connection setting',
      status: configured('DATABASE_URL') ? 'ready' : 'attention',
      detail: configured('DATABASE_URL') ? 'Database connection string is present; its value is never exposed.' : 'DATABASE_URL is missing from the API environment.',
    });
    checks.push({
      key: 'jwt-secret', label: 'JWT signing secret',
      status: configured('JWT_SECRET', 32) ? 'ready' : 'attention',
      detail: configured('JWT_SECRET', 32) ? 'Signing secret is present and meets the 32-character minimum.' : 'Missing or shorter than the 32-character minimum.',
    });
    checks.push({
      key: 'id-secret', label: 'Identity encryption secret',
      status: configured('SWASS_ID_SECRET', 32) ? 'ready' : 'attention',
      detail: configured('SWASS_ID_SECRET', 32) ? 'Identity secret is present and meets the 32-character minimum.' : 'Missing or shorter than the 32-character minimum.',
    });
    let database = 'down';
    try {
      await this.db.pool.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'unavailable';
    }
    checks.push({
      key: 'database-live', label: 'Live database connectivity',
      status: database === 'connected' ? 'ready' : 'attention',
      detail: database === 'connected' ? 'The API completed a database health query.' : 'The API could not complete a database health query.',
    });
    let audit = 'unavailable';
    try {
      await this.db.ensureSecuritySchema();
      await this.db.pool.query('SELECT id FROM aurora_security_events ORDER BY id DESC LIMIT 1');
      audit = 'ready';
    } catch {
      audit = 'unavailable';
    }
    checks.push({
      key: 'security-audit', label: 'Security event storage',
      status: audit === 'ready' ? 'ready' : 'attention',
      detail: audit === 'ready' ? 'Security event table is available for recording and review.' : 'Security event storage could not be verified.',
    });
    return {
      environment: process.env.NODE_ENV || 'development',
      runtime: 'Node.js / NestJS',
      database,
      securityAudit: audit,
      checkedAt: new Date().toISOString(),
      checks,
      integrations: [
        { key: 'sms', label: 'SMS / OTP provider', status: 'not_verified', detail: 'Provider credentials and delivery are not tested by this status check. Verify them in the hosting environment and with a real test OTP.' },
        { key: 'payments', label: 'Payment gateway', status: 'not_verified', detail: 'Gateway credentials and live STK/payment callbacks are not tested here.' },
        { key: 'backups', label: 'Database backups', status: 'not_connected', detail: 'Backup schedule and restore tests are managed outside this application and are not connected to this portal.' },
      ],
    };
  }

  @Post('shops/:tenantId/deactivate')
  async deactivateShop(@Param('tenantId') tenantId: string, @Req() req: any) {
    const id = String(tenantId || '').trim();
    if (!id || id.length > 80) throw new BadRequestException('A valid shop identifier is required');
    const result = await this.db.pool.query(
      `UPDATE tenants SET status='suspended' WHERE id=$1 AND status='active'
       RETURNING id AS "tenantId", name AS "businessName", status`, [id],
    );
    if (!result.rowCount) {
      const existing = await this.db.pool.query('SELECT id,status FROM tenants WHERE id=$1 LIMIT 1', [id]);
      if (!existing.rowCount) throw new NotFoundException('Shop not found');
      return { deactivated: false, status: existing.rows[0].status, message: 'This shop is already inactive or suspended.' };
    }
    await this.db.recordSecurityEvent({
      eventType: 'shop_deactivated', severity: 'info', outcome: 'completed',
      actorUserId: req.user?.sub, sourceIp: req.ip, userAgent: req.headers?.['user-agent'],
      metadata: { tenantId: id, businessName: result.rows[0].businessName },
    });
    return { deactivated: true, shop: result.rows[0], message: 'Shop deactivated successfully.' };
  }

  @Post('accounts/reset')
  async resetRegisteredAccounts(@Req() req: any) {
    await this.db.ensureSecuritySchema();
    const result = await this.db.tx(async client => {
      const users = await client.query(
        `UPDATE users
            SET is_active=false, national_id_number=NULL, national_id_photo_data=NULL
          WHERE role <> 'super_admin'
            AND NOT EXISTS (
              SELECT 1 FROM aurora_admin_identity_records admin_record
               WHERE admin_record.user_id = users.id
            )
          RETURNING id`,
      );
      const userIds = users.rows.map((row: { id: string }) => row.id);
      if (userIds.length) {
        await client.query('DELETE FROM aurora_owner_identity_records WHERE user_id = ANY($1::uuid[])', [userIds]);
      }
      const customers = await client.query(
        `UPDATE customer_accounts SET is_active=false
          WHERE is_active=true RETURNING id`,
      );
      const subscriptions = await client.query(
        `UPDATE subscriptions
            SET status='expired', auto_renew=false,
                ends_at=GREATEST(now(), starts_at + interval '1 second')
          WHERE status='active'
          RETURNING id`,
      );
      const ownerOtps = await client.query(
        `UPDATE signup_otp_requests SET expires_at=now()
          WHERE expires_at>now() RETURNING id`,
      );
      const customerOtps = await client.query(
        `UPDATE customer_signup_otp_requests SET expires_at=now()
          WHERE expires_at>now() RETURNING id`,
      );
      return {
        deactivatedUserAccounts: users.rowCount || 0,
        deactivatedCustomerAccounts: customers.rowCount || 0,
        expiredSubscriptions: subscriptions.rowCount || 0,
        expiredPendingOwnerRegistrations: ownerOtps.rowCount || 0,
        expiredPendingCustomerRegistrations: customerOtps.rowCount || 0,
      };
    });
    // The reset transaction is the source of truth. Audit logging must not
    // turn a successfully committed reset into a misleading HTTP failure.
    try {
      await this.db.recordSecurityEvent({
        eventType: 'registered_accounts_reset',
        severity: 'high',
        outcome: 'completed',
        actorUserId: req.user?.sub,
        sourceIp: req.ip,
        userAgent: req.headers?.['user-agent'],
        metadata: result,
      });
    } catch (error) {
      console.error('[AURORA_ADMIN] Account reset committed, but audit logging failed:', error instanceof Error ? error.message : error);
    }
    return {
      reset: true,
      ...result,
      preserved: ['super_admin accounts', 'businesses and stores', 'receipts and sales history', 'customers and inventory', 'financial ledger and payment history'],
      message: 'Non-admin login accounts have been deactivated and subscriptions expired. Historical business records remain preserved; previous users can register again using their details.',
    };
  }

}
