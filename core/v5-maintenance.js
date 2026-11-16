/** A local scheduler, independent of browser visibility and the host OS time zone. */
export function maintenanceWindow(now,config){
  const offset=8*3600000,day=86400000,date=new Date(now+offset);
  const start=config.maintenance_start_hour??1,hours=config.maintenance_hours??5;
  const hour=date.getUTCHours()+date.getUTCMinutes()/60+date.getUTCSeconds()/3600;
  const allowed=(hour-start+24)%24<hours;
  let next=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),start)-offset;
  if(next<=now)next+=day;
  return {allowed,time_zone:'Asia/Shanghai',start_hour:start,duration_hours:hours,next_start:allowed?null:next};
}
